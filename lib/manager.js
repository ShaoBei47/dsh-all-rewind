// Session manager: turns DSH session events into snapshot commits and exposes
// the rewind surface used by the tools, the HTTP API and the client panel.
import fs from 'node:fs'
import path from 'node:path'
import { SessionSnapshotStore } from './store.js'
import { KeyedQueue, ensureDir, errorMessage, messagePreview, readJson, sanitizeSegment } from './util.js'

const POINT_LIMIT = 200

export class RewindManager {
  /**
   * @param {object} options
   * @param {object} options.config resolved plugin config
   * @param {(msg: string, level?: string) => void} [options.log]
   * @param {object} [options.services] optional DSH services (sessions/agents/sandboxPolicy)
   * @param {() => number} [options.now]
   * @param {string} [options.gitExecutable]
   */
  constructor({ config, log, services = {}, now = () => Date.now(), gitExecutable }) {
    this.config = config
    this.log = log ?? (() => {})
    this.services = services
    this.now = now
    this.gitExecutable = gitExecutable
    this.dataDir = path.join(config.dataDir, 'snapshots')
    this.states = new Map()
    this.queue = new KeyedQueue()
    this.pending = new Set()
    this.lastTurn = new Map()
    this.callNames = new Map()
    this.turnCounters = new Map()
    this.lastAutoMaintainAt = new Map()
    ensureDir(this.dataDir)
  }

  // ------------------------------------------------------------- lifecycle

  setServices(services) {
    this.services = { ...this.services, ...services }
  }

  storeDir(sessionId) {
    return path.join(this.dataDir, sanitizeSegment(sessionId), 'v2')
  }

  getSession(sessionId) {
    try {
      return this.services.sessions?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Resolve (and lazily create) the store for a live session.
   * Returns `undefined` when the session has no usable workspace.
   */
  storeForSession(session) {
    const sessionId = session?.id
    if (!sessionId) return undefined
    const existing = this.states.get(sessionId)
    if (existing) return existing.store
    const workspace = session?.header?.cwd
    if (!workspace || typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
      this.log(`skip session ${sessionId}: no absolute cwd in session header`, 'warn')
      return undefined
    }
    if (!fs.existsSync(workspace)) {
      this.log(`skip session ${sessionId}: workspace does not exist (${workspace})`, 'warn')
      return undefined
    }
    const store = new SessionSnapshotStore({
      dir: this.storeDir(sessionId),
      sessionId,
      workspace,
      config: this.config,
      now: this.now,
      log: this.log,
      gitExecutable: this.gitExecutable,
    })
    this.states.set(sessionId, { store, workspace })
    return store
  }

  /** Recover a store for a session that is no longer live (API listing). */
  storeForId(sessionId) {
    const existing = this.states.get(sessionId)
    if (existing) return existing.store
    const graph = readJson(path.join(this.storeDir(sessionId), 'first_graph.json'), undefined)
    if (!graph?.workspace) return undefined
    const store = new SessionSnapshotStore({
      dir: this.storeDir(sessionId),
      sessionId,
      workspace: graph.workspace,
      config: this.config,
      now: this.now,
      log: this.log,
      gitExecutable: this.gitExecutable,
    })
    this.states.set(sessionId, { store, workspace: graph.workspace })
    return store
  }

  // ----------------------------------------------------------------- hooks

  /** `session/created`: record the workspace baseline before any turn runs. */
  onSessionCreated(session) {
    const store = this.storeForSession(session)
    if (!store) return
    this.enqueue(session.id, async () => {
      try {
        store.ensureInit()
        const latest = store.latestVersion()
        if (!latest) {
          store.capture({ type: 'baseline', label: `baseline-${this.now()}`, force: true })
        }
      } catch (error) {
        this.log(`baseline snapshot failed for ${session.id}: ${errorMessage(error)}`, 'warn')
      }
    })
  }

  /**
   * `session/event`: the durable log feed.
   *   turn/start    -> before-chat-turn-<turn>
   *   tool/call     -> remember the tool name for the matching result
   *   tool/result   -> toolcall-<turn>-<callId> (unless the tool is read-only)
   *   user/message  -> attach a preview to the current rewind point
   */
  onSessionEvent(session, event) {
    if (!session || !event || typeof event.type !== 'string') return
    const sessionId = session.id
    switch (event.type) {
      case 'turn/start': {
        this.lastTurn.set(sessionId, event.data?.turn ?? null)
        const store = this.storeForSession(session)
        if (!store) return
        const turn = event.data?.turn ?? null
        this.enqueue(sessionId, async () => {
          try {
            store.capture({ type: 'before-chat-turn', turn })
            // C): prune outside the keepTurns window (points + old toolcalls).
            store.pruneVersions({ keepTurns: this.config.keepTurns })
            this.maybeAutoMaintain(sessionId, store)
          } catch (error) {
            this.log(`before-chat-turn snapshot failed for ${sessionId}: ${errorMessage(error)}`, 'warn')
          }
        })
        return
      }
      case 'tool/call': {
        const callId = event.data?.callId
        if (callId) this.callNames.set(`${sessionId}\u0000${callId}`, event.data?.name ?? '')
        return
      }
      case 'tool/result': {
        const data = event.data ?? {}
        const callId = data.message?.toolCallId ?? data.message?.source?.callId
        const name = callId ? this.callNames.get(`${sessionId}\u0000${callId}`) ?? '' : ''
        if (callId) this.callNames.delete(`${sessionId}\u0000${callId}`)
        if (this.shouldSkipTool(name)) return
        const store = this.storeForSession(session)
        if (!store) return
        const turn = data.turn ?? this.lastTurn.get(sessionId) ?? null
        this.enqueue(sessionId, async () => {
          try {
            store.capture({ type: 'toolcall', turn, messageId: callId ?? null })
          } catch (error) {
            this.log(`toolcall snapshot failed for ${sessionId}: ${errorMessage(error)}`, 'warn')
          }
        })
        return
      }
      case 'user/message': {
        const store = this.storeForSession(session)
        if (!store) return
        const preview = messagePreview(event.data)
        if (!preview) return
        const turn = this.lastTurn.get(sessionId) ?? null
        this.enqueue(sessionId, async () => {
          try {
            store.updatePreview({ turn, preview })
          } catch (error) {
            this.log(`preview update failed for ${sessionId}: ${errorMessage(error)}`, 'warn')
          }
        })
        return
      }
      default:
    }
  }

  /**
   * C): bounded-disk safety net. Cheap check every `checkEveryTurns` turns;
   * runs a full GC only when the repository exceeds the configured threshold.
   */
  maybeAutoMaintain(sessionId, store) {
    const settings = this.config.autoMaintenance
    if (!settings?.enabled) return
    const counter = (this.turnCounters.get(sessionId) ?? 0) + 1
    this.turnCounters.set(sessionId, counter)
    if (counter % settings.checkEveryTurns !== 0) return
    const status = store.status()
    if (status.diskBytes < settings.thresholdBytes) return
    const result = store.maintenance({ keepVersions: settings.keepVersions })
    this.lastAutoMaintainAt.set(sessionId, this.now())
    this.log(
      `auto maintenance ${sessionId}: dropped ${result.droppedVersions.length} versions, `
      + `freed ${result.freedBytes} bytes (now ${result.diskBytes} bytes)`,
    )
  }

  shouldSkipTool(name) {
    if (!name) return false
    const skip = new Set(this.config.captureSkipTools)
    if (skip.has(name)) return true
    return name.startsWith('rewind_')
  }

  enqueue(sessionId, task) {
    const pending = this.queue.run(sessionId, task).catch((error) => {
      this.log(`queued snapshot task failed: ${errorMessage(error)}`, 'warn')
    })
    this.pending.add(pending)
    pending.finally(() => this.pending.delete(pending))
    return pending
  }

  /** Wait for every queued snapshot task (tests, shutdown, API writes). */
  async drain() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending])
    }
    return true
  }

  // ------------------------------------------------------------------ reads

  /** Rewind points for one session, newest first. */
  points({ sessionId, limit = POINT_LIMIT, includeToolcalls = false }) {
    const store = this.storeForId(sessionId)
    if (!store) return []
    return store.listPoints({ limit, includeToolcalls })
  }

  /** Every session with a snapshot repository, newest activity first. */
  listSessions() {
    let names
    try {
      names = fs.readdirSync(this.dataDir, { withFileTypes: true })
    } catch {
      return []
    }
    const live = new Set()
    try {
      for (const agent of this.services.agents?.list?.() ?? []) live.add(agent.id)
    } catch {
      // agents service absent: everything is simply not-live
    }
    const sessions = []
    for (const entry of names) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.dataDir, entry.name, 'v2')
      const graph = readJson(path.join(dir, 'first_graph.json'), undefined)
      if (!graph?.sessionId) continue
      const store = this.storeForId(graph.sessionId)
      if (!store) continue
      const latest = store.latestVersion()
      const points = store.listPoints({ limit: POINT_LIMIT })
      sessions.push({
        sessionId: graph.sessionId,
        workspace: graph.workspace,
        dir,
        active: live.has(graph.sessionId),
        points: points.length,
        latestTime: latest?.time ?? graph.createdAt ?? null,
        latestLabel: latest?.label ?? null,
        diskBytes: store.status().diskBytes,
      })
    }
    sessions.sort((a, b) => (b.latestTime ?? 0) - (a.latestTime ?? 0))
    return sessions
  }

  status() {
    const sessions = this.listSessions()
    const totalBytes = sessions.reduce((sum, entry) => sum + (entry.diskBytes ?? 0), 0)
    return {
      plugin: 'dsh-all-rewind',
      version: '0.4.0',
      // Snapshot storage location (absolute) and total bytes used by all
      // per-session repositories — shown in the client panel footer.
      storage: {
        dataDir: this.config.dataDir,
        snapshotsDir: this.dataDir,
        diskBytes: totalBytes,
      },
      config: {
        keepTurns: this.config.keepTurns,
        maxFileBytes: this.config.maxFileBytes,
        maxFiles: this.config.maxFiles,
        onConflict: this.config.onConflict,
        respectSandboxPolicy: this.config.respectSandboxPolicy,
        autoMaintenance: this.config.autoMaintenance,
      },
      sessions: sessions.length,
      points: sessions.reduce((sum, entry) => sum + entry.points, 0),
      backend: 'content-addressed-trees',
    }
  }

  // ---------------------------------------------------------------- restore

  /**
   * Roll the workspace back to `target` (a rewind point version/commit/label).
   * @param {object} options
   * @param {string} options.sessionId
   * @param {number|string} options.target
   * @param {boolean} [options.dryRun]
   * @param {'overwrite'|'skip'} [options.onConflict]
   * @param {boolean} [options.force] bypass the read-only sandbox guard
   */
  revert({ sessionId, target, dryRun = false, onConflict, force = false }) {
    const store = this.storeForId(sessionId)
    if (!store) {
      throw new Error(`no snapshot repository for session ${sessionId}; run at least one turn in that session first`)
    }
    if (!dryRun && this.config.respectSandboxPolicy && !force) {
      const session = this.getSession(sessionId)
      const policy = this.services.sandboxPolicy?.resolve?.({ session })
      if (policy?.mode === 'read-only') {
        const error = new Error(
          `session ${sessionId} runs in read-only mode; switch the permission preset before rolling back (or pass force)`,
        )
        error.code = 'READ_ONLY_SESSION'
        throw error
      }
    }
    const result = store.restore({ target, dryRun, onConflict })
    this.log(
      `rewind ${sessionId} -> ${result.target.label}: restored ${result.restored.length}, removed ${result.removed.length}${dryRun ? ' (dry run)' : ''}`,
      'info',
    )
    return result
  }

  prune({ sessionId } = {}) {
    const stores = sessionId ? [this.storeForId(sessionId)].filter(Boolean) : this.allStores()
    let dropped = 0
    for (const store of stores) {
      dropped += store.pruneVersions({ keepTurns: this.config.keepTurns }).removed.length
    }
    return { sessions: stores.length, dropped }
  }

  maintenance({ sessionId, keepVersions = this.config.autoMaintenance?.keepVersions ?? 200 } = {}) {
    const stores = sessionId ? [this.storeForId(sessionId)].filter(Boolean) : this.allStores()
    const results = []
    for (const store of stores) {
      try {
        results.push({ sessionId: store.sessionId, ...store.maintenance({ keepVersions }) })
      } catch (error) {
        results.push({ sessionId: store.sessionId, error: errorMessage(error) })
      }
    }
    return { sessions: results.length, results }
  }

  allStores() {
    let names
    try {
      names = fs.readdirSync(this.dataDir, { withFileTypes: true })
    } catch {
      return []
    }
    const stores = []
    for (const entry of names) {
      if (!entry.isDirectory()) continue
      const graph = readJson(path.join(this.dataDir, entry.name, 'v2', 'first_graph.json'), undefined)
      if (!graph?.sessionId) continue
      const store = this.storeForId(graph.sessionId)
      if (store) stores.push(store)
    }
    return stores
  }
}
