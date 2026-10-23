// DSH host plugin: wires the shadow-git rewind manager into the Cordis runtime.
//
// Registration order is deliberate: the session listeners, the tool-dispatch
// gate and the web index-injection row are registered immediately in `apply()`,
// while routes and tools wait for `webServer`/`tools` through `ctx.inject`.
// The desktop shell collects its injection table once at host start, so a row
// registered late would never reach the renderer.
import { ALWAYS_SKIP_TOOLS, resolveConfig } from './config.js'
import { API_PREFIX, RewindHttp } from './http.js'
import { RewindManager } from './manager.js'
import { errorMessage } from './util.js'

export const name = 'dsh-all-rewind'
export const version = '0.6.0'

const UI_PATH = `${API_PREFIX}/ui.js`
const UI_VERSION = `0.6.0`

/** Cordis forbids plugin `apply()` from returning arbitrary values; expose the
 * manager through this WeakMap instead (also handy in tests/diagnostics). */
const managers = new WeakMap()
export function managerOf(ctx) {
  return managers.get(ctx)
}
const UI_LOADER_TEXT =
  '(function(){try{var d=document.body||document.documentElement;if(!d)return;'
  + 'if(window.__dshAllRewindLoader)return;window.__dshAllRewindLoader=true;'
  + 'var s=document.createElement("script");s.src="' + UI_PATH + '?v=' + UI_VERSION + '";'
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
      description:
        'Show the shadow-git rewind status: git availability, storage location and size, workspaces and rewind points.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const status = await manager.status()
        const sessionId = args?.sessionId ?? ownSession(exec)
        if (!sessionId) return status
        return {
          ...status,
          session: await manager.sessionInfo(sessionId),
          points: await manager.points(sessionId, { limit: 20 }),
        }
      },
    },
    {
      name: 'rewind_list',
      description: 'List rewind points (one per conversation turn) that the workspace and conversation can be rolled back to.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          all: { type: 'boolean', description: 'List every session instead of only the caller session.' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        if (args?.all) return { sessions: manager.sessions() }
        const sessionId = args?.sessionId ?? ownSession(exec)
        if (!sessionId) return { sessions: manager.sessions() }
        return {
          sessionId,
          session: await manager.sessionInfo(sessionId),
          points: await manager.points(sessionId, { limit: Number(args?.limit) || 50 }),
        }
      },
    },
    {
      name: 'rewind_restore',
      description:
        'Roll the workspace files back to the state before a chosen conversation turn (or to an explicit snapshot commit). '
        + 'The conversation is NOT changed by this tool; the per-prompt rewind button in the chat UI rewinds both. '
        + 'A safety snapshot of the current state is recorded first, so the rollback itself can be undone.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          turn: { type: 'integer', minimum: 1, description: 'Rewind to the state before this conversation turn.' },
          commit: { type: 'string', description: 'Restore an explicit snapshot commit instead of a turn anchor.' },
          dryRun: { type: 'boolean', description: 'Only report which files would change.' },
          force: { type: 'boolean', description: 'Bypass the read-only sandbox guard.' },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const sessionId = args?.sessionId ?? ownSession(exec)
        if (!sessionId) throw new Error('rewind_restore needs a sessionId (no caller session was available)')
        return manager.restoreFiles({
          sessionId,
          turn: args?.turn,
          commit: args?.commit,
          dryRun: Boolean(args?.dryRun),
          force: Boolean(args?.force),
        })
      },
    },
    {
      name: 'rewind_prune',
      description: 'Drop rewind-point metadata beyond the configured keepTurns window.',
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
  for (const key of ['sessions', 'agents', 'sandboxPolicy', 'sessionQuery']) {
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
    manager.noteDiagnostic('applied', {
      version,
      dataDir: config.dataDir,
      gitExecutable: config.gitExecutable,
      conversation: config.conversation,
    })

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
    // The deferred conversation cut is appended during the model-request
    // waterfall: DSH only accepts a system/message inside an open turn/step, and
    // the append must land before the request's message list is derived.
    try {
      ctx.on('agent/request', (payload, next) => {
        try {
          manager.applyPendingConversationCut(payload)
        } catch (error) {
          log(`conversation cut hook failed: ${errorMessage(error)}`, 'warn')
        }
        return next()
      })
    } catch (error) {
      log(`cannot subscribe agent/request: ${errorMessage(error)}`, 'warn')
    }
    // The "before turn" snapshot must be complete before the first tool of that
    // turn can mutate the workspace. Tool dispatch is the only seam that can
    // write files, so gate it on the session's pending anchor work.
    try {
      ctx.on('tools/pre-execute', async (exec, next) => {
        try {
          await manager.settleSession(exec?.agent?.id)
        } catch (error) {
          log(`snapshot gate failed: ${errorMessage(error)}`, 'warn')
        }
        return next()
      })
    } catch (error) {
      log(`cannot subscribe tools/pre-execute: ${errorMessage(error)}`, 'warn')
    }
    try {
      ctx.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return
        if (table.some((row) => row && typeof row.text === 'string' && row.text.includes(UI_PATH))) return
        table.push({ kind: 'script', placement: 'body', text: UI_LOADER_TEXT })
        manager.noteDiagnostic('index-inject', { rows: table.length })
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
          ready.effect(() => ready.webServer.tapIndex((html) => {
            const next = injectUiTag(html)
            manager.noteDiagnostic('index-tap', { injected: next !== html, length: typeof html === 'string' ? html.length : 0 })
            return next
          }))
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
        manager.noteDiagnostic('ready', { capabilities: manager.capabilities() })
        log(`dsh-all-rewind ready (dataDir=${config.dataDir}, git=${config.gitExecutable})`)
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
