// DSH host plugin: wires the rewind manager into the Cordis runtime.
//
// Registration order is deliberate: the session listeners and the desktop
// index-injection row are registered immediately in `apply()`, while tools,
// routes and the browser index tap wait for `webServer`/`tools` through
// `ctx.inject`. The desktop shell collects its injection table once at host
// start, so a row registered late would never reach the renderer.
import { resolveConfig, ALWAYS_SKIP_TOOLS } from './config.js'
import { RewindHttp, API_PREFIX } from './http.js'
import { RewindManager } from './manager.js'
import { errorMessage } from './util.js'

export const name = 'dsh-all-rewind'
export const version = '0.4.0'

const UI_PATH = `${API_PREFIX}/ui.js`

/** Cordis forbids plugin `apply()` from returning arbitrary values; expose the
 * manager through this WeakMap instead (also handy in tests/diagnostics). */
const managers = new WeakMap()
export function managerOf(ctx) {
  return managers.get(ctx)
}
const UI_LOADER_TEXT =
  '(function(){try{var d=document.body||document.documentElement;if(!d)return;'
  + 'if(window.__dshAllRewindLoader)return;window.__dshAllRewindLoader=true;'
  + 'var s=document.createElement("script");s.src="' + UI_PATH + '";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/** Tools the plugin registers; they can never trigger a snapshot themselves. */
export const TOOL_NAMES = Object.freeze(['rewind_status', 'rewind_list', 'rewind_restore', 'rewind_prune'])

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false, required: [] }

function textRender(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function toolDefinition(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? EMPTY_SCHEMA,
    output: { schema: { type: 'object', properties: {} }, render: (_args, value) => textRender(value) },
    execute: tool.execute,
  }
}

export function registerTools(ctx, manager) {
  const ownSession = (exec) => exec?.agent?.id
  const tools = [
    {
      name: 'rewind_status',
      description: 'Show the TRAE-style rewind status: snapshot repositories, rewind points and disk usage.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const sessionId = args?.sessionId ?? ownSession(exec)
        if (args?.sessionId) return manager.status()
        if (!sessionId) return manager.status()
        const sessions = manager.listSessions()
        const mine = sessions.find((entry) => entry.sessionId === sessionId)
        return {
          ...manager.status(),
          session: mine ?? null,
          points: manager.points({ sessionId, limit: 20 }),
        }
      },
    },
    {
      name: 'rewind_list',
      description: 'List rewind points (one per conversation turn) that the workspace can be rolled back to.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          all: { type: 'boolean', description: 'List every session instead of only the caller session.' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          includeToolcalls: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        if (args?.all) return { sessions: manager.listSessions() }
        const sessionId = args?.sessionId ?? ownSession(exec)
        if (!sessionId) return { sessions: manager.listSessions() }
        return {
          sessionId,
          points: manager.points({
            sessionId,
            limit: Number(args?.limit) || 50,
            includeToolcalls: Boolean(args?.includeToolcalls),
          }),
        }
      },
    },
    {
      name: 'rewind_restore',
      description:
        'Roll the workspace back to the state before a chosen conversation turn: undo every file change that turn '
        + 'made. A safety snapshot is recorded automatically, so the rollback itself can be inspected.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          target: {
            oneOf: [
              { type: 'integer', minimum: 1 },
              { type: 'string', description: 'version number, commit sha, or label such as before-chat-turn-3' },
            ],
            description: 'Rewind point: version number, commit, or label. Defaults to the newest point.',
          },
          version: { type: 'integer', minimum: 1 },
          dryRun: { type: 'boolean', description: 'Only report which files would change.' },
          onConflict: { type: 'string', enum: ['overwrite', 'skip'] },
          force: { type: 'boolean', description: 'Bypass the read-only sandbox guard.' },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const sessionId = args?.sessionId ?? ownSession(exec)
        if (!sessionId) throw new Error('rewind_restore needs a sessionId (no caller session was available)')
        return manager.revert({
          sessionId,
          target: args?.target ?? args?.version,
          dryRun: Boolean(args?.dryRun),
          onConflict: args?.onConflict,
          force: Boolean(args?.force),
        })
      },
    },
    {
      name: 'rewind_prune',
      description: 'Drop old rewind-point metadata beyond the configured keepTurns window.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        additionalProperties: false,
      },
      execute: async (args) => manager.prune({ sessionId: args?.sessionId ?? undefined }),
    },
  ]
  const disposers = []
  for (const tool of tools) disposers.push(ctx.tools.register(toolDefinition(tool)))
  return disposers
}

export function injectUiTag(html) {
  if (typeof html !== 'string' || html.includes(UI_PATH)) return html
  const tag = `<script defer src="${UI_PATH}"></script>`
  return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
}

/** Optional-service proxy: reads resolve late, so load order never matters. */
function lazyServices(ctx) {
  const services = {}
  for (const key of ['sessions', 'agents', 'sandboxPolicy']) {
    Object.defineProperty(services, key, {
      enumerable: true,
      get() {
        try {
          return ctx.get(key)
        } catch {
          return undefined
        }
      },
    })
  }
  return services
}

export default {
  name,
  apply(ctx, rawConfig = {}) {
    const config = resolveConfig(rawConfig)
    let log = () => {}
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger
      if (logger) {
        log = (message, level = 'info') => {
          try {
            const fn = logger[level] ?? logger.info
            fn.call(logger, message)
          } catch {
            // logging must never break the plugin
          }
        }
      }
    } catch {
      // logger service unavailable
    }

    const manager = new RewindManager({ config, log, services: lazyServices(ctx) })
    const http = new RewindHttp({ manager, config, log })

    // --- immediate listeners ------------------------------------------------
    try {
      ctx.on('session/created', (session) => {
        try {
          manager.onSessionCreated(session)
        } catch (error) {
          log(`session/created hook failed: ${errorMessage(error)}`, 'warn')
        }
      })
    } catch (error) {
      log(`cannot subscribe session/created: ${errorMessage(error)}`, 'warn')
    }
    try {
      ctx.on('session/event', (session, event) => {
        try {
          manager.onSessionEvent(session, event)
        } catch (error) {
          log(`session/event hook failed: ${errorMessage(error)}`, 'warn')
        }
      })
    } catch (error) {
      log(`cannot subscribe session/event: ${errorMessage(error)}`, 'warn')
    }
    try {
      ctx.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return
        if (table.some((row) => row && typeof row.text === 'string' && row.text.includes(UI_PATH))) return
        table.push({ kind: 'script', placement: 'body', text: UI_LOADER_TEXT })
      })
    } catch (error) {
      log(`cannot subscribe webserver/index-inject: ${errorMessage(error)}`, 'warn')
    }

    // --- services that may arrive later ------------------------------------
    try {
      ctx.inject(['webServer', 'tools'], (ready) => {
        manager.setServices(lazyServices(ready))
        if (config.http.enabled) {
          for (const route of http.routes()) {
            ready.effect(() => ready.webServer.register(route))
          }
          ready.effect(() => ready.webServer.tapIndex((html) => injectUiTag(html)))
        }
        const disposers = registerTools(ready, manager)
        ready.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // already disposed
            }
          }
        })
        log(`dsh-all-rewind ready (dataDir=${config.dataDir})`)
      })
    } catch (error) {
      log(`dsh-all-rewind could not inject required services: ${errorMessage(error)}`, 'warn')
    }

    // Expose a tiny inspection handle for tests/diagnostics.
    manager.helpers = { config, http, API_PREFIX, ALWAYS_SKIP_TOOLS }
    managers.set(ctx, manager)
    try {
      ctx.set?.('traeRewind', manager)
    } catch {
      // the service is not provided in a real host; the WeakMap is authoritative
    }
  },
}
