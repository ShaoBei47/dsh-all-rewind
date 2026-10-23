// HTTP surface served through DSH's webServer: JSON API for the injected client
// action, plus that client script itself. Local-only by default (loopback Host
// required, cross-site browser requests rejected) because the endpoints can
// rewrite the workspace and fork the conversation on a POST.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_UI_FILE = HERE.replace(/lib[\\/]$/, '') + 'assets/ui.js'

export const API_PREFIX = '/dsh-all-rewind'

/** HTTP status for a manager failure code. */
function statusForCode(code) {
  switch (code) {
    case 'READ_ONLY_SESSION':
    case 'SESSION_RUNNING':
      return 409
    case 'NO_POINT':
      return 404
    case 'GIT_UNAVAILABLE':
    case 'CONVERSATION_UNAVAILABLE':
      return 503
    case 'BAD_REQUEST':
      return 400
    default:
      return 500
  }
}

export class RewindHttp {
  constructor({ manager, config, log, uiFile = DEFAULT_UI_FILE }) {
    this.manager = manager
    this.config = config
    this.log = log ?? (() => {})
    this.uiFile = uiFile
    this.handlers = new Map()
    this.#register()
  }

  routes() {
    return [...this.handlers.keys()].map((routePath) => ({
      kind: 'exact',
      path: routePath,
      handler: (req, res) => this.serve(routePath, req, res),
    }))
  }

  #register() {
    this.handlers.set(`${API_PREFIX}/ui.js`, (ctx) => this.#ui(ctx))
    this.handlers.set(`${API_PREFIX}/api/status`, (ctx) => this.#status(ctx))
    this.handlers.set(`${API_PREFIX}/api/sessions`, (ctx) => this.#sessions(ctx))
    this.handlers.set(`${API_PREFIX}/api/points`, (ctx) => this.#points(ctx))
    this.handlers.set(`${API_PREFIX}/api/rewind`, (ctx) => this.#rewind(ctx))
    this.handlers.set(`${API_PREFIX}/api/revert`, (ctx) => this.#rewind(ctx)) // legacy alias
    this.handlers.set(`${API_PREFIX}/api/prune`, (ctx) => this.#prune(ctx))
    this.handlers.set(`${API_PREFIX}/api/maintenance`, (ctx) => this.#maintenance(ctx))
    this.handlers.set(`${API_PREFIX}/api/health`, () => this.#json(200, { ok: true, plugin: 'dsh-all-rewind' }))
  }

  // -------------------------------------------------------------- transport

  /** Raw node handler used for webServer registration. */
  serve(routePath, req, res) {
    readBody(req, this.config.http.bodyLimitBytes)
      .then((body) => this.dispatch({
        method: req.method,
        path: routePath,
        url: req.url,
        headers: req.headers,
        body,
      }))
      .then((response) => {
        res.writeHead(response.status, response.headers)
        res.end(response.body)
      })
      .catch((error) => {
        this.log(`rewind http error: ${error?.message ?? error}`, 'warn')
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      })
  }

  /**
   * Testable request dispatcher: returns {status, headers, body}.
   * @param {{method?: string, path: string, url?: string, headers?: object, body?: Buffer|string}} request
   */
  async dispatch({ method = 'GET', path, url, headers = {}, body = '' }) {
    const trust = this.#trust(method, path, url, headers)
    if (trust) return this.#json(trust.status, { ok: false, error: trust.error }, trust.headers)
    const handler = this.handlers.get(path)
    if (!handler) return this.#json(404, { ok: false, error: `unknown route ${path}` })
    let payload = body
    if (payload && typeof payload === 'string') payload = Buffer.from(payload, 'utf8')
    if (!payload || payload.length === 0) payload = Buffer.alloc(0)
    if (payload.length > this.config.http.bodyLimitBytes) {
      return this.#json(413, { ok: false, error: 'request body too large' })
    }
    const context = {
      method: String(method || 'GET').toUpperCase(),
      path,
      query: parseQuery(url),
      body: payload,
      headers,
    }
    try {
      return await handler(context)
    } catch (error) {
      const code = error?.code
      const body = {
        ok: false,
        error: String(error?.message ?? error),
        code,
        ...(error?.result ? { result: error.result } : {}),
      }
      return this.#json(statusForCode(code), body)
    }
  }

  /** Loopback Host + same-origin + no cross-site fetch checks (fail closed). */
  #trust(method, routePath, url, headers) {
    if (!this.config.http.requireLocalOrigin) return undefined
    const host = String(headers.host ?? headers.Host ?? '')
    if (!isTrustedHost(host)) {
      return { status: 403, error: `untrusted Host header: ${host || '(missing)'}` }
    }
    const origin = headers.origin ?? headers.Origin
    if (origin) {
      try {
        const originHost = new URL(String(origin)).host
        if (!sameHost(originHost, host)) {
          return { status: 403, error: 'cross-origin request rejected' }
        }
      } catch {
        return { status: 403, error: 'malformed Origin header' }
      }
    }
    const fetchSite = String(headers['sec-fetch-site'] ?? headers['Sec-Fetch-Site'] ?? '')
    if (fetchSite.toLowerCase() === 'cross-site') {
      return { status: 403, error: 'cross-site request rejected' }
    }
    if (method !== 'GET' && method !== 'HEAD' && !isJsonPost(headers)) {
      return { status: 415, error: 'POST requires Content-Type: application/json' }
    }
    return undefined
  }

  // --------------------------------------------------------------- handlers

  async #status() {
    const status = await this.manager.status()
    const key = JSON.stringify(status.conversation)
    if (this.lastStatusKey !== key) {
      this.lastStatusKey = key
      this.manager.noteDiagnostic?.('status', { conversation: status.conversation })
    }
    return this.#json(200, { ok: true, ...status })
  }

  async #sessions() {
    return this.#json(200, { ok: true, sessions: this.manager.sessions() })
  }

  async #points(context) {
    const sessionId = context.query.get('sessionId') || context.query.get('session') || undefined
    const limit = Number(context.query.get('limit') ?? 50)
    if (sessionId) {
      const [points, info] = await Promise.all([
        this.manager.points(sessionId, { limit }),
        this.manager.sessionInfo(sessionId),
      ])
      return this.#json(200, {
        ok: true,
        sessionId,
        workspace: info?.workspace ?? null,
        conversation: info ? info.openTurn == null : false,
        pendingCut: this.manager.pendingCut(sessionId),
        points,
      })
    }
    return this.#json(200, {
      ok: true,
      sessions: this.manager.sessions(),
    })
  }

  async #rewind(context) {
    const body = parseJsonBody(context.body)
    const sessionId = body.sessionId
    if (!sessionId) return this.#json(400, { ok: false, error: 'sessionId is required' })
    const result = await this.manager.rewind({
      sessionId,
      turn: body.turn ?? body.version ?? body.target,
      mode: body.mode,
      dryRun: Boolean(body.dryRun),
      force: Boolean(body.force),
    })
    return this.#json(200, result)
  }

  async #prune(context) {
    const body = parseJsonBody(context.body, true)
    return this.#json(200, { ok: true, ...(await this.manager.prune({ sessionId: body.sessionId })) })
  }

  async #maintenance(context) {
    const body = parseJsonBody(context.body, true)
    return this.#json(200, { ok: true, ...(await this.manager.maintenance({ sessionId: body.sessionId })) })
  }

  #ui(context) {
    this.manager.noteDiagnostic?.('ui-served', { userAgent: String(context?.headers?.['user-agent'] ?? '').slice(0, 120) })
    let text
    try {
      text = fs.readFileSync(this.uiFile, 'utf8')
    } catch (error) {
      return this.#json(500, { ok: false, error: `ui asset unavailable: ${error.message}` })
    }
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      body: text,
    }
  }

  #json(status, value, extraHeaders) {
    return {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(value),
    }
  }
}

/** Read a request body with a hard byte limit (JSON APIs only; never streams to disk). */
function readBody(req, limit) {
  if (!req || typeof req.on !== 'function') return Promise.resolve(Buffer.alloc(0))
  const declared = Number(req.headers?.['content-length'] ?? req.headers?.['Content-Length'] ?? 0)
  if (declared > limit) return Promise.reject(Object.assign(new Error('request body too large'), { status: 413 }))
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(Buffer.concat(chunks))
    }
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        finish(Object.assign(new Error('request body too large'), { status: 413 }))
        try { req.destroy?.() } catch {}
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => finish())
    req.on('error', (error) => finish(error))
  })
}

function parseQuery(url) {
  const params = new URLSearchParams()
  if (typeof url === 'string') {
    const index = url.indexOf('?')
    if (index >= 0) {
      for (const [key, value] of new URLSearchParams(url.slice(index + 1))) params.append(key, value)
    }
  }
  return params
}

function parseJsonBody(buffer, allowEmpty = false) {
  const text = buffer.toString('utf8').trim()
  if (!text) {
    if (allowEmpty) return {}
    throw new Error('request body must be a JSON object')
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be a JSON object')
  return value
}

function isTrustedHost(host) {
  if (!host) return false
  let hostname = host
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const normalized = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
  if (!match) return false
  if (Number(match[1]) !== 127) return false
  return [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
}

function sameHost(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

function isJsonPost(headers) {
  const type = String(headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase()
  return type.includes('application/json') || type.includes('text/plain')
}
