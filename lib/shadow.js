// Durable shadow-git storage per workspace.
//
// One `ShadowRepository` (a private git dir) plus one `state.json` (turn anchors
// and per-session metadata) per DSH workspace, all under `config.dataDir`:
//
//   <dataDir>/shadows/<workspaceKey>/repo.git   git objects / refs / index
//   <dataDir>/shadows/<workspaceKey>/state.json turn anchors + session metadata
//
// A turn anchor is the commit that recorded the workspace *before* that turn
// ran, together with the session-log sequence boundary used to fork the
// conversation back to the same point.
import fs from 'node:fs'
import path from 'node:path'
import {
  GitRunner,
  GitUnavailableError,
  ShadowRepository,
  buildExcludeText,
  detectGit,
  workspaceKey,
} from './git.js'
import {
  KeyedQueue,
  dirSize,
  errorMessage,
  readJson,
  shortId,
  writeJsonAtomic,
} from './util.js'

const STATE_VERSION = 1
const QUEUE_KEY = 'workspace'

/** Fill defaults into a possibly old/partial state document. */
function normalizeState(raw, workspace) {
  const state = raw && typeof raw === 'object' ? raw : {}
  if (state.version !== STATE_VERSION || !state.sessions || typeof state.sessions !== 'object') {
    return { version: STATE_VERSION, workspace, createdAt: Date.now(), updatedAt: Date.now(), sessions: {}, counters: {} }
  }
  state.workspace = workspace
  state.sessions = state.sessions ?? {}
  state.counters = state.counters ?? {}
  return state
}

function sessionRecord(state, sessionId) {
  const id = String(sessionId)
  if (!state.sessions[id]) {
    state.sessions[id] = {
      parentSessionId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      openTurn: null,
      turns: {},
    }
  }
  return state.sessions[id]
}

/**
 * One workspace: shadow repository + durable anchor state. All git and state
 * mutations for the workspace run through a single queue so `add`/`commit`/
 * `read-tree` never interleave.
 */
export class ShadowWorkspace {
  /**
   * @param {object} options
   * @param {string} options.workspace absolute workspace path
   * @param {string} options.dir shadow workspace directory (repo.git + state.json)
   * @param {import('./git.js').GitRunner} options.git
   * @param {object} options.config resolved plugin config
   * @param {(message: string, level?: string) => void} [options.log]
   */
  constructor({ workspace, dir, git, config, log }) {
    this.workspace = workspace
    this.dir = dir
    this.git = git
    this.config = config
    this.log = log ?? (() => {})
    this.repo = new ShadowRepository({
      dir: path.join(dir, 'repo.git'),
      workTree: workspace,
      git,
    })
    this.stateFile = path.join(dir, 'state.json')
    this.state = normalizeState(readJson(this.stateFile, undefined), workspace)
    this.queue = new KeyedQueue()
    this.ready = false
  }

  key() {
    return path.basename(this.dir)
  }

  save() {
    this.state.updatedAt = Date.now()
    writeJsonAtomic(this.stateFile, this.state)
  }

  /** Exclude rules: workspace ignore + our defaults + anything inside dataDir. */
  excludeText() {
    const extra = [...this.config.extraExcludes]
    // Never snapshot our own repositories when dataDir was configured inside the
    // workspace (the workspace root is the git work tree here).
    const relative = path.relative(this.workspace, this.config.dataDir)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      extra.push(`${relative.replace(/\\/g, '/')}/`)
    }
    return buildExcludeText({
      ignoreDirs: this.config.ignoreDirs,
      ignoreFiles: this.config.ignoreFiles,
      extraExcludes: extra,
    })
  }

  async init() {
    if (this.ready) return
    await this.repo.ensure({ excludeText: this.excludeText(), gitTimeoutMs: this.config.gitTimeoutMs })
    this.ready = true
  }

  /** Run `task` inside this workspace's serial queue. */
  run(task) {
    return this.queue.run(QUEUE_KEY, task)
  }

  session(sessionId) {
    return sessionRecord(this.state, sessionId)
  }

  getSession(sessionId) {
    return this.state.sessions[String(sessionId)]
  }

  /** Record (or find) the anchor that belongs to one turn. */
  recordTurn({ sessionId, turn, seq, preview, prompt, commit, filesChanged, reused }) {
    const record = this.session(sessionId)
    record.updatedAt = Date.now()
    const pending = record.previewPending
    const effectivePreview = preview ?? (pending && pending.turn === turn ? pending.preview : null)
    const effectivePrompt = prompt ?? (pending && pending.turn === turn ? pending.prompt : null)
    record.turns[String(turn)] = {
      commit,
      seq,
      seqBefore: seq - 1,
      time: Date.now(),
      preview: effectivePreview ?? null,
      prompt: effectivePrompt ?? null,
      filesChanged: filesChanged ?? 0,
      reused: Boolean(reused),
    }
    if (pending && pending.turn === turn) record.previewPending = null
    this.save()
    return record.turns[String(turn)]
  }

  setPreview(sessionId, turn, { preview, prompt }) {
    const record = this.session(sessionId)
    const entry = record.turns[String(turn)]
    if (!entry || !preview) {
      // The prompt can arrive before the asynchronous turn snapshot finishes.
      if (preview) record.previewPending = { turn, preview, prompt }
      return
    }
    if (entry.preview === preview && entry.prompt === prompt) return
    entry.preview = preview
    if (prompt) entry.prompt = prompt
    record.updatedAt = Date.now()
    this.save()
  }

  setOpenTurn(sessionId, turn) {
    const record = sessionRecord(this.state, sessionId)
    record.openTurn = turn ?? null
    record.updatedAt = Date.now()
    this.save()
  }

  markCreated(sessionId, parentSessionId) {
    const record = sessionRecord(this.state, sessionId)
    record.parentSessionId = parentSessionId ?? null
    this.save()
    return record
  }

  /**
   * Copy inherited turn anchors from a fork source so the child session can still
   * rewind its inherited conversation.
   * @param {string} parentSessionId
   * @param {string} childSessionId
   * @param {number|undefined} beforeTurn exclusive upper bound
   * @returns {number} copied turn count
   */
  copyInheritedAnchors(parentSessionId, childSessionId, beforeTurn) {
    const parent = this.getSession(parentSessionId)
    if (!parent) return 0
    const child = sessionRecord(this.state, childSessionId)
    child.parentSessionId = String(parentSessionId)
    let copied = 0
    for (const [turnKey, entry] of Object.entries(parent.turns)) {
      const turn = Number(turnKey)
      if (!Number.isFinite(turn)) continue
      if (Number.isFinite(beforeTurn) && turn >= beforeTurn) continue
      child.turns[turnKey] = { ...entry }
      copied += 1
    }
    child.updatedAt = Date.now()
    this.save()
    return copied
  }

  /** Keep only the newest `keepTurns` anchors of one session. */
  pruneTurns(sessionId, keepTurns) {
    const record = this.getSession(sessionId)
    if (!record) return []
    const turns = Object.keys(record.turns).map(Number).filter(Number.isFinite).sort((a, b) => b - a)
    const dropped = []
    for (const turn of turns.slice(keepTurns)) {
      delete record.turns[String(turn)]
      dropped.push(turn)
    }
    if (dropped.length > 0) this.save()
    return dropped
  }

  /** Drop every anchor at or after `fromTurn` (a conversation cut makes them unreachable). */
  pruneFromTurn(sessionId, fromTurn) {
    const record = this.getSession(sessionId)
    if (!record) return []
    const dropped = []
    for (const turnKey of Object.keys(record.turns)) {
      const turn = Number(turnKey)
      if (Number.isFinite(turn) && turn >= fromTurn) {
        delete record.turns[turnKey]
        dropped.push(turn)
      }
    }
    if (dropped.length > 0) this.save()
    return dropped
  }

  /** Persist the deferred conversation cut so a restart can still apply it. */
  setPendingCut(sessionId, cut) {
    const record = this.session(sessionId)
    record.pendingCut = {
      turn: cut.turn,
      cutAtSeq: cut.cutAtSeq,
      createdAt: cut.createdAt ?? Date.now(),
    }
    record.updatedAt = Date.now()
    this.save()
    return record.pendingCut
  }

  /** Forget the deferred cut once it was appended to the live session. */
  clearPendingCut(sessionId) {
    const record = this.getSession(sessionId)
    if (!record?.pendingCut) return
    record.pendingCut = null
    record.updatedAt = Date.now()
    this.save()
  }

  pendingCut(sessionId) {
    return this.getSession(sessionId)?.pendingCut ?? undefined
  }

  /** Snapshot the workspace before a turn runs. */
  async captureBeforeTurn({ sessionId, turn, seq, preview }) {
    return this.run(async () => {
      const record = this.getSession(sessionId) ?? this.session(sessionId)
      const existing = record.turns[String(turn)]
      if (existing) return { ...existing, turn, reused: true }
      await this.init()
      const result = await this.repo.snapshot({
        message: `dsh-rewind: before-chat-turn-${turn} (${shortId(sessionId, 14)})`,
        gitTimeoutMs: this.config.gitTimeoutMs,
      })
      const point = this.recordTurn({
        sessionId,
        turn,
        seq,
        preview,
        commit: result.commit,
        filesChanged: result.filesChanged,
        reused: result.reused,
      })
      this.pruneTurns(sessionId, this.config.keepTurns)
      return { ...point, turn }
    })
  }

  /**
   * Rewind the working tree to one turn anchor.
   * A safety commit records the pre-restore state first, so the rewind itself
   * can be reverted by pointing a later restore at it.
   */
  async restoreTurn({ sessionId, turn }) {
    return this.run(async () => {
      const record = this.getSession(sessionId)
      const anchor = record?.turns?.[String(turn)]
      if (!anchor) {
        const error = new Error(`session ${sessionId} has no rewind point for turn ${turn}`)
        error.code = 'NO_POINT'
        throw error
      }
      await this.init()
      const safety = await this.repo.snapshot({
        message: `dsh-rewind: safety before rewinding to turn ${turn} (${shortId(sessionId, 14)})`,
        gitTimeoutMs: this.config.gitTimeoutMs,
      })
      const preview = await this.repo.restore(anchor.commit, { gitTimeoutMs: this.config.gitTimeoutMs })
      const safetyRecord = this.session(sessionId)
      safetyRecord.updatedAt = Date.now()
      safetyRecord.lastSafety = { commit: safety.commit, time: Date.now(), turn }
      this.save()
      return {
        commit: anchor.commit,
        safetyCommit: safety.commit,
        ...preview,
      }
    })
  }

  /** Restore an explicit commit (used by the rewind_restore tool). */
  async restoreCommit(commit) {
    return this.run(async () => {
      await this.init()
      if (!(await this.repo.hasCommit(commit))) {
        const error = new Error(`unknown snapshot commit ${commit}`)
        error.code = 'NO_POINT'
        throw error
      }
      const safety = await this.repo.snapshot({
        message: `dsh-rewind: safety before restoring ${shortId(commit, 10)}`,
        gitTimeoutMs: this.config.gitTimeoutMs,
      })
      const preview = await this.repo.restore(commit, { gitTimeoutMs: this.config.gitTimeoutMs })
      return { commit, safetyCommit: safety.commit, ...preview }
    })
  }

  async gc() {
    await this.init()
    const result = await this.repo.gc({ gitTimeoutMs: this.config.gitTimeoutMs })
    this.state.counters = this.state.counters ?? {}
    this.state.counters.lastGcAt = Date.now()
    this.save()
    return result
  }

  sizeBytes() {
    return dirSize(this.dir)
  }

  /** Number of anchors currently recorded for one session. */
  pointCount(sessionId) {
    const record = this.getSession(sessionId)
    return record ? Object.keys(record.turns).length : 0
  }
}

/**
 * Registry of workspace shadow stores + the high-level operations the manager,
 * HTTP API and tools use. Git is detected lazily so a missing git only disables
 * the feature with a clear status report instead of failing plugin load.
 */
export class ShadowStore {
  /**
   * @param {object} options
   * @param {object} options.config resolved plugin config
   * @param {(message: string, level?: string) => void} [options.log]
   * @param {() => number} [options.now]
   */
  constructor({ config, log, now = () => Date.now() }) {
    this.config = config
    this.log = log ?? (() => {})
    this.now = now
    this.root = path.join(config.dataDir, 'shadows')
    this.workspaces = new Map()
    this.git = undefined
    this.gitError = null
    this.gitInfo = null
    this.turnCounters = new Map()
    // Disk-size listings walk every object file; the client polls status, so the
    // walk result is reused for a short window instead of on every request.
    this.sizeCache = new Map()
  }

  cachedDirSize(key, dir, ttlMs = 15_000) {
    const now = this.now()
    const cached = this.sizeCache.get(key)
    if (cached && now - cached.at < ttlMs) return cached.bytes
    const bytes = dirSize(dir)
    this.sizeCache.set(key, { at: now, bytes })
    return bytes
  }

  /** Resolve (once) the git executable. */
  async ensureGit() {
    if (this.git) return this.git
    if (this.gitError) throw this.gitError
    try {
      const info = await detectGit(this.config.gitExecutable)
      this.gitInfo = info
      if (!info.compatible) {
        this.log(`git ${info.version} is older than the supported ${MIN_VERSION_TEXT()}; snapshotting may fail`, 'warn')
      }
      this.git = new GitRunner({
        executable: info.executable,
        version: info.version,
        emptyConfigPath: path.join(this.config.dataDir, '.git', 'empty-gitconfig'),
        timeoutMs: this.config.gitTimeoutMs,
        log: this.log,
      })
      this.log(`shadow git ready: ${info.executable} ${info.version}`)
      return this.git
    } catch (error) {
      this.gitError = error instanceof GitUnavailableError
        ? error
        : new GitUnavailableError(errorMessage(error))
      this.log(`shadow git unavailable: ${this.gitError.message}`, 'warn')
      throw this.gitError
    }
  }

  /** git availability for status output (never throws). */
  async gitStatus() {
    try {
      await this.ensureGit()
      return {
        available: true,
        executable: this.gitInfo.executable,
        version: this.gitInfo.version,
        compatible: this.gitInfo.compatible,
      }
    } catch (error) {
      return {
        available: false,
        executable: this.config.gitExecutable,
        version: null,
        error: errorMessage(error),
      }
    }
  }

  /** The workspace entry for an absolute workspace path (created lazily, once). */
  async workspace(cwd) {
    const workspace = path.resolve(String(cwd))
    const key = workspaceKey(workspace)
    const cached = this.workspaces.get(key)
    if (cached) return cached
    // Cache the creation promise synchronously: two events of the same turn can
    // ask for the workspace concurrently, and they must share one state object.
    const created = (async () => {
      const git = await this.ensureGit()
      return new ShadowWorkspace({
        workspace,
        dir: path.join(this.root, key),
        git,
        config: this.config,
        log: this.log,
      })
    })()
    this.workspaces.set(key, created)
    try {
      return await created
    } catch (error) {
      this.workspaces.delete(key)
      throw error
    }
  }

  /** Every workspace with a state file on disk (including not-yet-loaded ones). */
  listWorkspaces() {
    let names
    try {
      names = fs.readdirSync(this.root, { withFileTypes: true })
    } catch {
      return []
    }
    const entries = []
    for (const dirent of names) {
      if (!dirent.isDirectory()) continue
      const dir = path.join(this.root, dirent.name)
      const state = readJson(path.join(dir, 'state.json'), undefined)
      if (!state?.workspace) continue
      entries.push({ key: dirent.name, dir, state })
    }
    return entries
  }

  /** Locate the workspace that owns a session id. */
  findSession(sessionId) {
    const id = String(sessionId)
    for (const entry of this.listWorkspaces()) {
      if (entry.state.sessions?.[id]) return { ...entry, session: entry.state.sessions[id] }
    }
    return undefined
  }

  async workspaceForSession(sessionId) {
    const found = this.findSession(sessionId)
    if (!found) return undefined
    const workspace = await this.workspace(found.state.workspace)
    return { workspace, found }
  }

  /** Snapshot the workspace before a turn runs. */
  async captureBeforeTurn({ cwd, sessionId, turn, seq, preview }) {
    const entry = await this.workspace(cwd)
    try {
      const point = await entry.captureBeforeTurn({ sessionId, turn, seq, preview })
      await this.maybeAutoMaintain(entry)
      return point
    } catch (error) {
      this.log(`before-turn snapshot failed for ${sessionId} turn ${turn}: ${errorMessage(error)}`, 'warn')
      return undefined
    }
  }

  /** Set/refresh a turn preview (user prompt text) for UI labels. */
  async rememberPreview({ cwd, sessionId, turn, preview, prompt }) {
    if (!Number.isFinite(turn) || !preview) return
    const entry = await this.workspace(cwd)
    return entry.run(() => entry.setPreview(sessionId, turn, { preview, prompt }))
  }

  /** Mark the turn lifecycle (running: turn number, idle: null). */
  async setOpenTurn({ cwd, sessionId, turn }) {
    const entry = await this.workspace(cwd)
    return entry.run(() => entry.setOpenTurn(sessionId, turn))
  }

  /** Announcement hooks for session creation / fork lineage. */
  async sessionCreated({ cwd, sessionId, parentSessionId, beforeTurn }) {
    const entry = await this.workspace(cwd)
    return entry.run(() => {
      if (parentSessionId) {
        const copied = entry.copyInheritedAnchors(parentSessionId, sessionId, beforeTurn)
        if (copied > 0) this.log(`session ${sessionId} inherited ${copied} rewind anchors from ${parentSessionId}`)
      } else {
        entry.markCreated(sessionId, null)
      }
    })
  }

  /** Rewind points for one session, newest turn first. */
  points(sessionId, { limit = 50 } = {}) {
    const found = this.findSession(sessionId)
    if (!found?.session) return []
    const turns = Object.entries(found.session.turns ?? {})
      .map(([key, value]) => ({ turn: Number(key), ...value }))
      .filter((entry) => Number.isFinite(entry.turn))
      .sort((a, b) => b.turn - a.turn)
      .slice(0, limit)
    return turns.map((entry) => ({
      turn: entry.turn,
      label: `before-chat-turn-${entry.turn}`,
      commit: entry.commit,
      seq: entry.seq,
      seqBefore: entry.seqBefore,
      time: entry.time,
      preview: entry.preview ?? null,
      prompt: entry.prompt ?? null,
      filesChanged: entry.filesChanged ?? 0,
      rewindable: true,
    }))
  }

  /** File preview for a rewind (no writes). */
  async previewRewind({ sessionId, turn }) {
    const found = this.findSession(sessionId)
    if (!found?.session) {
      const error = new Error(`unknown session ${sessionId}`)
      error.code = 'NO_POINT'
      throw error
    }
    const anchor = found.session.turns?.[String(turn)]
    if (!anchor) {
      const error = new Error(`session ${sessionId} has no rewind point for turn ${turn}`)
      error.code = 'NO_POINT'
      throw error
    }
    const workspace = await this.workspace(found.state.workspace)
    const preview = await workspace.run(async () => {
      await workspace.init()
      return workspace.repo.previewRestore(anchor.commit)
    })
    return { ...preview, commit: anchor.commit }
  }

  /** Restore workspace files to a turn anchor (safety commit included). */
  async restoreTurn({ sessionId, turn }) {
    const found = this.findSession(sessionId)
    if (!found?.session) {
      const error = new Error(`unknown session ${sessionId}`)
      error.code = 'NO_POINT'
      throw error
    }
    const workspace = await this.workspace(found.state.workspace)
    return workspace.restoreTurn({ sessionId, turn })
  }

  /** Restore an explicit commit in the session's workspace. */
  async restoreCommit({ sessionId, commit }) {
    const found = this.findSession(sessionId)
    if (!found) {
      const error = new Error(`unknown session ${sessionId}`)
      error.code = 'NO_POINT'
      throw error
    }
    const workspace = await this.workspace(found.state.workspace)
    return workspace.restoreCommit(commit)
  }

  /** Session metadata for one session (workspace, anchor count, parent). */
  sessionInfo(sessionId) {
    const found = this.findSession(sessionId)
    if (!found) return undefined
    return {
      sessionId: String(sessionId),
      workspace: found.state.workspace,
      parentSessionId: found.session?.parentSessionId ?? null,
      openTurn: found.session?.openTurn ?? null,
      pendingCut: found.session?.pendingCut ?? null,
      points: Object.keys(found.session?.turns ?? {}).length,
      diskBytes: this.cachedDirSize(`dir:${found.state.workspace}`, found.dir),
    }
  }

  /** Persist a deferred conversation cut for one session. */
  async setPendingCut({ sessionId, cut }) {
    const found = this.findSession(sessionId)
    if (!found) return false
    const workspace = await this.workspace(found.state.workspace)
    return workspace.run(() => workspace.setPendingCut(sessionId, cut))
  }

  /** Read the persisted deferred cut of one session (state-file read only). */
  pendingCut(sessionId) {
    const found = this.findSession(sessionId)
    return found?.session?.pendingCut ?? undefined
  }

  /** Clear the deferred cut after it was applied to the live session. */
  async clearPendingCut(sessionId) {
    const found = this.findSession(sessionId)
    if (!found) return false
    const workspace = await this.workspace(found.state.workspace)
    return workspace.run(() => workspace.clearPendingCut(sessionId))
  }

  /** Drop anchors at or after a turn (after its conversation was truncated). */
  async pruneFromTurn({ sessionId, fromTurn }) {
    const found = this.findSession(sessionId)
    if (!found) return { dropped: [] }
    const workspace = await this.workspace(found.state.workspace)
    const dropped = await workspace.run(() => workspace.pruneFromTurn(sessionId, fromTurn))
    return { dropped }
  }

  /** Every session with anchors, newest activity first. */
  listSessions() {
    const sessions = []
    for (const entry of this.listWorkspaces()) {
      for (const [sessionId, record] of Object.entries(entry.state.sessions ?? {})) {
        sessions.push({
          sessionId,
          workspace: entry.state.workspace,
          parentSessionId: record.parentSessionId ?? null,
          openTurn: record.openTurn ?? null,
          points: Object.keys(record.turns ?? {}).length,
          latestTime: record.updatedAt ?? record.createdAt ?? null,
          diskBytes: this.cachedDirSize(`dir:${entry.state.workspace}`, entry.dir),
        })
      }
    }
    sessions.sort((a, b) => (b.latestTime ?? 0) - (a.latestTime ?? 0))
    return sessions
  }

  /** Total disk usage of every shadow repository. */
  diskBytes() {
    return this.cachedDirSize('root', this.root)
  }

  /** Drop turn anchors beyond `keepTurns` (state only; git objects are shared). */
  async prune({ sessionId } = {}) {
    let dropped = 0
    for (const entry of this.listWorkspaces()) {
      const ids = sessionId ? [String(sessionId)] : Object.keys(entry.state.sessions ?? {})
      const targets = ids.filter((id) => entry.state.sessions?.[id])
      if (targets.length === 0) continue
      const workspace = await this.workspace(entry.state.workspace)
      for (const id of targets) {
        dropped += workspace.pruneTurns(id, this.config.keepTurns).length
      }
    }
    return { dropped }
  }

  /** Run `git gc` for one or every workspace. */
  async maintenance({ sessionId } = {}) {
    const results = []
    let entries = this.listWorkspaces()
    if (sessionId) entries = entries.filter((entry) => entry.state.sessions?.[sessionId])
    for (const entry of entries) {
      try {
        const workspace = await this.workspace(entry.state.workspace)
        const result = await workspace.run(() => workspace.gc())
        results.push({ workspace: entry.state.workspace, ...result })
        this.log(
          `gc ${entry.state.workspace}: ${result.bytesBefore} -> ${result.bytesAfter} bytes`,
        )
      } catch (error) {
        results.push({ workspace: entry.state.workspace, error: errorMessage(error) })
      }
    }
    return { workspaces: results.length, results }
  }

  /** Cheap periodic maintenance: gc only when the total exceeds the threshold. */
  async maybeAutoMaintain(entry) {
    const settings = this.config.autoMaintenance
    if (!settings?.enabled) return
    const counter = (this.turnCounters.get(entry.key()) ?? 0) + 1
    this.turnCounters.set(entry.key(), counter)
    if (counter % settings.checkEveryTurns !== 0) return
    const size = entry.sizeBytes()
    if (size < settings.thresholdBytes) return
    try {
      await entry.run(() => entry.gc())
      this.log(`auto gc for ${entry.workspace}: now ${entry.sizeBytes()} bytes`)
    } catch (error) {
      this.log(`auto gc failed for ${entry.workspace}: ${errorMessage(error)}`, 'warn')
    }
  }

  /** Resolved plugin status (tools, HTTP API, client panel footer). */
  async status() {
    const git = await this.gitStatus()
    const workspaces = this.listWorkspaces()
    const sessions = this.listSessions()
    const points = sessions.reduce((sum, entry) => sum + entry.points, 0)
    return {
      plugin: 'dsh-all-rewind',
      version: '0.6.0',
      backend: 'shadow-git',
      git,
      storage: {
        dataDir: this.config.dataDir,
        shadowsDir: this.root,
        diskBytes: this.diskBytes(),
      },
      config: {
        keepTurns: this.config.keepTurns,
        conversation: this.config.conversation,
        respectSandboxPolicy: this.config.respectSandboxPolicy,
        autoMaintenance: this.config.autoMaintenance,
      },
      workspaces: workspaces.map((entry) => ({
        workspace: entry.state.workspace,
        sessions: Object.keys(entry.state.sessions ?? {}).length,
        diskBytes: this.cachedDirSize(`dir:${entry.state.workspace}`, entry.dir),
      })),
      sessions: sessions.length,
      points,
    }
  }
}

function MIN_VERSION_TEXT() {
  return '2.13'
}
