// Session manager: turns DSH session events into shadow-git turn anchors and
// performs a TRAE-style rewind - restore workspace files, then truncate the
// conversation **in place**.
//
// Conversation rewind follows DSH's own compaction mechanism: append an empty
// `system/message` surface node whose `surfaceOp.replace` range covers every
// surface node from the target turn's `turn/start` onwards. The node projects no
// message, so both the model history and the web transcript lose that content
// immediately, in the *same* session - no fork, no new conversation.
//
// DSH only accepts a `system/message` inside an open turn/step, so the append is
// deferred to the next model request: the rewind request stores a pending cut and
// the `agent/request` waterfall applies it right before the request is derived.
// The client hides the messages visually in the meantime.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ShadowStore } from './shadow.js'
import { KeyedQueue, errorMessage, messagePreview, messageText, writeJsonAtomic } from './util.js'

const POINT_LIMIT = 200
const DIAGNOSTIC_EVENT_LIMIT = 60

export class RewindManager {
  /**
   * @param {object} options
   * @param {object} options.config resolved plugin config
   * @param {(msg: string, level?: string) => void} [options.log]
   * @param {object} [options.services] optional DSH services (sessions, agents, sandboxPolicy)
   * @param {() => number} [options.now]
   */
  constructor({ config, log, services = {}, now = () => Date.now() }) {
    this.config = config
    this.log = log ?? (() => {})
    this.services = services
    this.now = now
    this.store = new ShadowStore({ config, log: this.log, now })
    this.pending = new Set()
    this.pendingBySession = new Map()
    this.lastTurn = new Map()
    this.actions = new KeyedQueue()
    // sessionId -> { turn, cutAtSeq, createdAt }: deferred conversation cuts.
    this.pendingCuts = new Map()
    this.loadedCuts = new Set()
    this.diagnosticsFile = path.join(config.dataDir, 'diagnostics.json')
    this.diagnostics = {
      version: '0.6.0',
      appliedAt: this.now(),
      capabilities: null,
      events: [],
      lastError: null,
    }
  }

  // ------------------------------------------------------------- lifecycle

  setServices(services) {
    this.services = { ...this.services, ...services }
    this.diagnostics.capabilities = this.capabilities()
    this.noteDiagnostic('services', { capabilities: this.diagnostics.capabilities })
  }

  /** Which optional host services this composition exposes to the plugin. */
  capabilities() {
    const has = (name) => {
      try {
        return Boolean(this.services[name])
      } catch {
        return false
      }
    }
    return {
      sessions: has('sessions'),
      agents: has('agents'),
      sessionQuery: has('sessionQuery'),
      sandboxPolicy: has('sandboxPolicy'),
    }
  }

  /** Append one diagnostic event and persist the trail (never throws). */
  noteDiagnostic(name, data = {}) {
    let event = { time: this.now(), name }
    try {
      event = { time: this.now(), name, ...plain(data) }
      this.diagnostics.events.push(event)
      if (this.diagnostics.events.length > DIAGNOSTIC_EVENT_LIMIT) this.diagnostics.events.shift()
      writeJsonAtomic(this.diagnosticsFile, this.diagnostics)
    } catch {
      // diagnostics must never break a request
    }
    return event
  }

  /** Record a failure with code/message/stack for later inspection. */
  recordError(where, error) {
    const record = {
      where,
      time: this.now(),
      code: error?.code ?? null,
      message: errorMessage(error),
      stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 12).join('\n') : null,
    }
    this.diagnostics.lastError = record
    this.noteDiagnostic(`error:${where}`, record)
    return record
  }

  getSession(sessionId) {
    try {
      return this.services.sessions?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  enqueue(sessionId, task) {
    const pending = Promise.resolve().then(task).catch((error) => {
      this.log(`rewind task failed: ${errorMessage(error)}`, 'warn')
    })
    this.pending.add(pending)
    const key = sessionId == null ? undefined : String(sessionId)
    if (key) {
      if (!this.pendingBySession.has(key)) this.pendingBySession.set(key, new Set())
      this.pendingBySession.get(key).add(pending)
    }
    pending.finally(() => {
      this.pending.delete(pending)
      if (key) this.pendingBySession.get(key)?.delete(pending)
    })
    return pending
  }

  /** Wait for every queued snapshot task (used before reads/writes and by tests). */
  async settle() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending])
    }
  }

  /** Wait only for the queued snapshot work of one session (fast tool gate). */
  async settleSession(sessionId) {
    if (sessionId == null) return
    const key = String(sessionId)
    while (true) {
      const running = this.pendingBySession.get(key)
      if (!running || running.size === 0) return
      await Promise.all([...running])
    }
  }

  // ----------------------------------------------------------------- hooks

  /** `session/created`: remember the workspace and copy fork lineage anchors. */
  onSessionCreated(session) {
    const sessionId = session?.id
    const cwd = session?.header?.cwd
    if (!sessionId || !isAbsoluteDirectory(cwd)) return
    const parentSessionId = session?.header?.parentSession ?? null
    const task = this.store.sessionCreated({ cwd, sessionId, parentSessionId, beforeTurn: undefined })
    this.enqueue(sessionId, () => task)
  }

  /**
   * `session/event`: the durable log feed.
   *   turn/start   -> anchor the workspace state before this turn
   *   user/message -> remember the prompt as the turn's UI preview
   *   turn/end     -> mark the session idle again
   */
  onSessionEvent(session, event) {
    if (!session?.id || !event || typeof event.type !== 'string') return
    const sessionId = session.id
    const cwd = session?.header?.cwd
    switch (event.type) {
      case 'turn/start': {
        const turn = event?.data?.turn
        if (!Number.isFinite(turn)) return
        this.lastTurn.set(sessionId, turn)
        if (!isAbsoluteDirectory(cwd)) return
        const seq = Number(event.seq)
        if (!Number.isFinite(seq)) return
        const record = this.store.setOpenTurn({ cwd, sessionId, turn })
        this.enqueue(sessionId, () => record)
        const capture = this.store.captureBeforeTurn({ cwd, sessionId, turn, seq, preview: null })
        this.enqueue(sessionId, () => capture)
        return
      }
      case 'user/message': {
        if (!isAbsoluteDirectory(cwd)) return
        const turn = this.lastTurn.get(sessionId)
        if (!Number.isFinite(turn)) return
        const preview = messagePreview(event.data)
        if (!preview) return
        const prompt = messageText(event.data)
        this.enqueue(sessionId, () => this.store.rememberPreview({ cwd, sessionId, turn, preview, prompt }))
        return
      }
      case 'turn/end': {
        if (!isAbsoluteDirectory(cwd)) return
        this.lastTurn.delete(sessionId)
        const task = this.store.setOpenTurn({ cwd, sessionId, turn: null })
        this.enqueue(sessionId, () => task)
        return
      }
      default:
    }
  }

  /**
   * `agent/request` waterfall: apply a pending conversation cut inside the open
   * turn/step, before the request's messages are derived. Must stay synchronous.
   * @param {{agent?: {session?: object}, turn?: number, step?: number}} payload
   * @returns {void}
   */
  applyPendingConversationCut(payload) {
    try {
      const session = payload?.agent?.session
      const sessionId = session?.id
      if (!sessionId) return
      const pending = this.#pendingCut(sessionId)
      if (!pending) return
      const turn = Number(payload?.turn)
      const step = Number(payload?.step)
      if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return
      if (!Number.isFinite(pending.cutAtSeq) || pending.cutAtSeq < 0) {
        this.#clearPendingCut(sessionId)
        return
      }
      const result = this.#rewriteSurface(session, pending.cutAtSeq, { turn, step })
      this.#clearPendingCut(sessionId)
      this.noteDiagnostic('cut-applied', {
        sessionId,
        turn: pending.turn,
        appliedAtTurn: turn,
        appliedAtStep: step,
        shadowed: result.shadowed,
        ranges: result.ranges,
        startSeq: result.startSeq,
        endSeq: result.endSeq,
      })
      try {
        this.services.sessions?.flush?.(session)
      } catch {
        // flush is best-effort; the live append already publishes the surface
      }
      this.log(`conversation rewound in place: session=${sessionId} turn=${pending.turn} shadowed=${result.shadowed}`)
    } catch (error) {
      this.recordError('cut-apply', error)
    }
  }

  // ------------------------------------------------------------------ reads

  async points(sessionId, { limit = POINT_LIMIT } = {}) {
    if (!sessionId) return []
    await this.settle()
    return this.store.points(sessionId, { limit })
  }

  async sessionInfo(sessionId) {
    if (!sessionId) return undefined
    await this.settle()
    return this.store.sessionInfo(sessionId)
  }

  sessions() {
    return this.store.listSessions()
  }

  async status() {
    await this.settle()
    const status = await this.store.status()
    return {
      ...status,
      conversation: {
        enabled: this.config.conversation.enabled,
        mode: 'surface-replace',
        pendingCuts: [...this.pendingCuts.entries()].map(([sessionId, cut]) => ({ sessionId, ...cut })),
      },
      activeSessions: this.lastTurn.size,
      diagnostics: {
        file: this.diagnosticsFile,
        lastError: this.diagnostics.lastError,
      },
    }
  }

  /** Pending conversation cut for one session (client polling uses this). */
  pendingCut(sessionId) {
    return this.#pendingCut(sessionId) ?? null
  }

  // ----------------------------------------------------------------- writes

  /**
   * Roll the workspace back to the state before `turn` and truncate the
   * conversation in place. The conversation cut is deferred to the next model
   * request (DSH only permits appending inside an open turn/step).
   *
   * @param {object} options
   * @param {string} options.sessionId
   * @param {number} options.turn
   * @param {'all'|'files'|'chat'} [options.mode]
   * @param {boolean} [options.dryRun]
   * @param {boolean} [options.force]
   */
  rewind({ sessionId, turn, mode = 'all', dryRun = false, force = false }) {
    return this.actions.run(String(sessionId ?? ''), async () => {
      try {
        return await this.#rewind({ sessionId, turn, mode, dryRun, force })
      } catch (error) {
        this.recordError('rewind', error)
        throw error
      }
    })
  }

  async #rewind({ sessionId, turn, mode, dryRun, force }) {
    const id = String(sessionId ?? '')
    const targetTurn = Number(turn)
    if (!id) throw badRequest('sessionId is required')
    if (!Number.isFinite(targetTurn) || targetTurn < 1) throw badRequest('turn must be a positive integer')
    const normalizedMode = mode === 'files' || mode === 'chat' ? mode : 'all'
    const wantsFiles = normalizedMode === 'all' || normalizedMode === 'files'
    const wantsChat = normalizedMode === 'all' || normalizedMode === 'chat'

    if (wantsChat && !this.config.conversation.enabled) {
      throw failure('CONVERSATION_DISABLED', 'conversation rewind is disabled in this plugin configuration')
    }

    // Make every in-flight snapshot visible before validating the point.
    await this.settle()
    const info = this.store.sessionInfo(id)
    if (!info) {
      throw failure(
        'NO_POINT',
        `session ${id} has no rewind points; start a new turn after installing dsh-all-rewind and try again`,
      )
    }
    if (info.openTurn != null) {
      throw failure('SESSION_RUNNING', `session ${id} is still running turn ${info.openTurn}; wait for it to finish`)
    }
    const point = this.store.points(id, { limit: POINT_LIMIT }).find((entry) => entry.turn === targetTurn)
    if (!point) {
      throw failure('NO_POINT', `session ${id} has no rewind point for turn ${targetTurn}`)
    }

    if (wantsFiles) this.#assertWritable(id, force)

    this.noteDiagnostic('rewind', {
      sessionId: id,
      turn: targetTurn,
      mode: normalizedMode,
      dryRun,
      capabilities: this.capabilities(),
    })

    const result = {
      ok: true,
      sessionId: id,
      turn: targetTurn,
      workspace: info.workspace,
      mode: normalizedMode,
      files: null,
      conversation: null,
      warnings: [],
    }

    if (dryRun) {
      if (wantsFiles) {
        const preview = await this.store.previewRewind({ sessionId: id, turn: targetTurn })
        result.files = { restored: preview.restored, removed: preview.removed, dryRun: true }
      }
      if (wantsChat) result.conversation = { dryRun: true, deferred: true, cutAtSeq: point.seq, turn: targetTurn }
      return result
    }

    // 1) Files first: a safety commit makes the restore itself reversible.
    if (wantsFiles) {
      try {
        const restored = await this.store.restoreTurn({ sessionId: id, turn: targetTurn })
        result.files = {
          restored: restored.restored,
          removed: restored.removed,
          safetyCommit: restored.safetyCommit,
        }
      } catch (error) {
        throw withResult(error, result)
      }
    }

    // 2) Conversation: persist a deferred in-place surface cut and prune the
    // anchors that no longer describe a reachable conversation.
    if (wantsChat) {
      try {
        const cut = {
          turn: targetTurn,
          cutAtSeq: point.seq,
          createdAt: this.now(),
        }
        this.pendingCuts.set(id, cut)
        await this.store.setPendingCut({ sessionId: id, cut })
        await this.store.pruneFromTurn({ sessionId: id, fromTurn: targetTurn })
        this.noteDiagnostic('cut-pending', { sessionId: id, ...cut })
        result.conversation = {
          deferred: true,
          mode: 'surface-replace',
          turn: targetTurn,
          cutAtSeq: cut.cutAtSeq,
        }
      } catch (error) {
        this.pendingCuts.delete(id)
        throw withResult(error, result)
      }
    }

    this.noteDiagnostic('rewind-done', {
      sessionId: id,
      turn: targetTurn,
      deferred: Boolean(result.conversation?.deferred),
      restored: result.files ? result.files.restored.length : 0,
      removed: result.files ? result.files.removed.length : 0,
    })
    this.log(
      `rewind ${id} to before turn ${targetTurn}: files ${result.files ? result.files.restored.length : 0} restored, `
      + `conversation cut ${result.conversation?.deferred ? 'pending (next request)' : 'not requested'}`,
    )
    return result
  }

  /** Files-only rewind used by the `rewind_restore` tool. */
  restoreFiles({ sessionId, turn, commit, dryRun = false, force = false }) {
    return this.actions.run(String(sessionId ?? ''), async () => {
      const id = String(sessionId ?? '')
      if (!id) throw badRequest('sessionId is required')
      await this.settle()
      if (!this.store.sessionInfo(id)) throw failure('NO_POINT', `session ${id} has no rewind points`)
      this.#assertWritable(id, force)
      if (commit) {
        if (dryRun) throw failure('DRY_RUN_UNSUPPORTED', 'dryRun is only supported for turn targets')
        return this.store.restoreCommit({ sessionId: id, commit })
      }
      const targetTurn = Number(turn)
      if (!Number.isFinite(targetTurn) || targetTurn < 1) throw badRequest('turn must be a positive integer')
      if (dryRun) {
        const preview = await this.store.previewRewind({ sessionId: id, turn: targetTurn })
        return { dryRun: true, turn: targetTurn, restored: preview.restored, removed: preview.removed }
      }
      return this.store.restoreTurn({ sessionId: id, turn: targetTurn })
    })
  }

  async prune({ sessionId } = {}) {
    await this.settle()
    return this.store.prune({ sessionId })
  }

  async maintenance(options = {}) {
    await this.settle()
    return this.store.maintenance(options)
  }

  // --------------------------------------------------------------- internals

  #assertWritable(sessionId, force) {
    if (!this.config.respectSandboxPolicy || force) return
    const session = this.getSession(sessionId)
    const policy = this.services.sandboxPolicy?.resolve?.({ session })
    if (policy?.mode === 'read-only') {
      throw failure(
        'READ_ONLY_SESSION',
        `session ${sessionId} runs in read-only mode; switch the permission preset before rewinding (or pass force)`,
      )
    }
  }

  /** Pending cut for one session, loading the persisted copy once. */
  #pendingCut(sessionId) {
    if (this.pendingCuts.has(sessionId)) return this.pendingCuts.get(sessionId)
    if (this.loadedCuts.has(sessionId)) return undefined
    this.loadedCuts.add(sessionId)
    try {
      const stored = this.store.pendingCut(sessionId)
      if (stored) {
        this.pendingCuts.set(sessionId, stored)
        return stored
      }
    } catch {
      // a missing/corrupt state file simply means "no pending cut"
    }
    return undefined
  }

  #clearPendingCut(sessionId) {
    this.pendingCuts.delete(sessionId)
    this.loadedCuts.add(sessionId)
    try {
      this.store.clearPendingCut(sessionId)
    } catch (error) {
      this.log(`could not clear pending cut for ${sessionId}: ${errorMessage(error)}`, 'warn')
    }
  }

  /**
   * Append the empty system surface nodes that replace every surface node at or
   * after `cutAtSeq`. Replicates DSH's prompt consolidation: the first surface
   * head node is protected by replacing it with itself, then the remaining range
   * is replaced.
   * @returns {{shadowed: number, ranges: number, startSeq: number|null, endSeq: number|null}}
   */
  #rewriteSurface(session, cutAtSeq, { turn, step }) {
    const nodes = Array.from(session.surface?.nodes ?? [])
    const shadowed = nodes.filter((seq) => Number(seq) >= cutAtSeq)
    if (shadowed.length === 0) return { shadowed: 0, ranges: 0, startSeq: null, endSeq: null }
    const head = nodes[0]
    const appends = []
    if (shadowed[0] === head) {
      appends.push({ startSeq: head, endSeq: head, sourceEventSeqs: [head] })
      const rest = shadowed.slice(1)
      if (rest.length > 0) {
        appends.push({ startSeq: rest[0], endSeq: rest[rest.length - 1], sourceEventSeqs: rest })
      }
    } else {
      appends.push({
        startSeq: shadowed[0],
        endSeq: shadowed[shadowed.length - 1],
        sourceEventSeqs: shadowed,
      })
    }
    const message = () => ({
      id: randomUUID(),
      role: 'system',
      content: [],
      source: { kind: 'system-prompt' },
    })
    let last = null
    for (const append of appends) {
      session.append(
        'system/message',
        { turn, step, message: message() },
        {
          surfaceOp: { op: 'replace', startSeq: append.startSeq, endSeq: append.endSeq },
          sourceEventSeqs: append.sourceEventSeqs,
        },
      )
      last = append
    }
    return {
      shadowed: shadowed.length,
      ranges: appends.length,
      startSeq: appends[0].startSeq,
      endSeq: last.endSeq,
    }
  }
}

function plain(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || value === undefined ? undefined : value
  }
  if (depth > 3) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => plain(entry, depth + 1))
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    const converted = plain(entry, depth + 1)
    if (converted !== undefined) result[key] = converted
  }
  return result
}

function isAbsoluteDirectory(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false
  try {
    return fs.statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

function badRequest(message) {
  const error = new Error(message)
  error.code = 'BAD_REQUEST'
  return error
}

function failure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function withResult(error, result) {
  if (error && typeof error === 'object') {
    error.result = result
  }
  return error
}
