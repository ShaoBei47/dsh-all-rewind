// The snapshot store: one hidden, content-addressed repository per DSH session.
//
// Layout (mirrors the TRAE v2 snapshot directory):
//
//   <dataDir>/snapshots/<sessionId>/v2/
//     objects/<aa>/<rest>   zlib-deflated, content-addressed:
//                           - file blobs (sha256 of content)
//                           - directory tree nodes (see lib/tree.js)
//     base/content/<rel>    workspace mirror at the latest snapshot
//     disk/content/<rel>    last deleted copy of a removed file (advisory)
//     version_file_<n>.json small metadata: tree id, changed paths, preview
//     first_graph.json      repository identity (session + workspace)
//     latest_change.json    pointer to the newest version
//
// Structural sharing: a version stores only its root tree id. Unchanged
// directories/files reuse the same tree/blob ids, so per-version metadata is
// O(changed paths) instead of O(all files) — the fix for the disk blow-up
// measured on large workspaces.
//
// Snapshot anchors (the labels the UI maps back to):
//   baseline-<time>            first observation of the session workspace
//   before-chat-turn-<turn>    state before the turn's first token
//   toolcall-<turn>-<callId>   state after one AI tool call
//   pre-revert-<time>          safety point taken right before a rollback
//   post-revert-<time>         baseline recorded after a rollback
import fs from 'node:fs'
import path from 'node:path'
import { ObjectStore, commitIdOf } from './objects.js'
import { buildTree, collectTreeObjects, enumerateTree } from './tree.js'
import { diffManifests, planRestore, scanWorkspace } from './workspace.js'
import {
  dirSize, ensureDir, formatBytes, fromRepoPath, pathExists, readJson, sanitizeSegment,
  writeJsonAtomic,
} from './util.js'

export const MARKER_TYPES = Object.freeze(['baseline', 'before-chat-turn', 'pre-revert', 'post-revert', 'init'])

export class SnapshotError extends Error {
  constructor(message, code = 'SNAPSHOT_ERROR') {
    super(message)
    this.name = 'SnapshotError'
    this.code = code
  }
}

function nowIso() {
  return new Date().toISOString()
}

function versionFile(dir, version) {
  return path.join(dir, `version_file_${version}.json`)
}

export class SessionSnapshotStore {
  /**
   * @param {object} options
   * @param {string} options.dir         the `.../v2` directory for this session
   * @param {string} options.sessionId   DSH session id
   * @param {string} options.workspace   absolute workspace (session cwd)
   * @param {object} options.config      resolved plugin config
   * @param {() => number} [options.now] injectable clock for tests
   * @param {(msg: string, level?: string) => void} [options.log]
   */
  constructor({ dir, sessionId, workspace, config, now = () => Date.now(), log }) {
    this.dir = dir
    this.sessionId = sessionId
    this.workspace = workspace
    this.config = config
    this.now = now
    this.log = log ?? (() => {})
    this.branch = `session-${sanitizeSegment(sessionId)}`
    this._initialised = false
    this._versionCache = undefined
    this._treeCache = new Map()
    this.objects = new ObjectStore(dir)
  }

  get baseDir() {
    return path.join(this.dir, 'base', 'content')
  }

  get diskDir() {
    return path.join(this.dir, 'disk', 'content')
  }

  get firstGraphFile() {
    return path.join(this.dir, 'first_graph.json')
  }

  get latestFile() {
    return path.join(this.dir, 'latest_change.json')
  }

  /** Create the repository skeleton (idempotent). */
  ensureInit() {
    if (this._initialised) return this
    if (!this.workspace || !path.isAbsolute(this.workspace)) {
      throw new SnapshotError(`invalid workspace for session ${this.sessionId}`, 'INVALID_WORKSPACE')
    }
    if (!pathExists(this.workspace)) {
      throw new SnapshotError(`workspace does not exist: ${this.workspace}`, 'WORKSPACE_UNAVAILABLE')
    }
    ensureDir(this.dir)
    ensureDir(this.baseDir)
    ensureDir(this.diskDir)
    if (!pathExists(this.firstGraphFile)) {
      writeJsonAtomic(this.firstGraphFile, {
        schemaVersion: 2,
        layout: 'v2',
        backend: 'content-addressed-trees',
        brand: 'dsh-all-rewind',
        sessionId: this.sessionId,
        workspace: this.workspace,
        branch: this.branch,
        createdAt: this.now(),
      })
    }
    this._initialised = true
    return this
  }

  // ---------------------------------------------------------------- history

  /** All version metadata files, oldest first. */
  loadVersions() {
    let names
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return []
    }
    const versions = []
    for (const name of names) {
      const match = /^version_file_(\d+)\.json$/.exec(name)
      if (!match) continue
      const data = readJson(path.join(this.dir, name), undefined)
      if (data && typeof data.version === 'number') versions.push(data)
    }
    versions.sort((a, b) => a.version - b.version)
    return versions
  }

  latestVersion() {
    if (this._versionCache !== undefined) return this._versionCache
    const versions = this.loadVersions()
    this._versionCache = versions.length ? versions[versions.length - 1] : null
    return this._versionCache ?? undefined
  }

  invalidateCache() {
    this._versionCache = undefined
  }

  readVersion(version) {
    if (!Number.isFinite(Number(version))) return undefined
    return readJson(versionFile(this.dir, Number(version)), undefined)
  }

  /** Resolve `version` (number), a full/partial commit/tree id, or a label. */
  resolveTarget(ref) {
    const versions = this.loadVersions()
    if (versions.length === 0) return undefined
    if (ref === undefined || ref === null || ref === '') return versions[versions.length - 1]
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      return versions.find((entry) => entry.version === Number(ref))
    }
    const text = String(ref)
    return versions.find((entry) => entry.label === text)
      ?? versions.slice().reverse().find((entry) => String(entry.commit ?? '').startsWith(text))
      ?? versions.slice().reverse().find((entry) => String(entry.tree ?? '').startsWith(text))
  }

  /**
   * Full manifest (repoPath -> { sha256 }) of a version.
   * New format walks the immutable tree; legacy version files stored the map
   * inline and keep working.
   */
  manifestOfVersion(version) {
    if (!version) return {}
    if (version.tree) return enumerateTree(this.objects, version.tree, { cache: this._treeCache })
    const manifest = {}
    for (const [repoPath, meta] of Object.entries(version.files ?? {})) {
      const sha = meta.sha256 ?? meta.blob
      if (sha) manifest[repoPath] = { sha256: sha }
    }
    return manifest
  }

  /** The newest snapshot manifest (authority for "files the AI created"). */
  latestManifest() {
    return this.manifestOfVersion(this.latestVersion())
  }

  /** Rewind points: `before-chat-turn` markers (+ the baseline), newest first. */
  listPoints({ limit = 50, includeToolcalls = false } = {}) {
    const versions = this.loadVersions()
    const points = []
    for (const version of versions) {
      const isPoint = version.type === 'before-chat-turn' || version.type === 'baseline'
      if (!isPoint && !includeToolcalls) continue
      points.push({
        version: version.version,
        commit: version.commit,
        tree: version.tree,
        label: version.label,
        type: version.type,
        turn: version.turn ?? null,
        messageId: version.messageId ?? null,
        preview: version.preview ?? '',
        time: version.time,
        createdAt: version.createdAt,
        changed: version.changed?.changed ?? 0,
        files: version.stats?.files ?? version.snapshot?.files ?? 0,
        bytes: version.stats?.bytes ?? version.snapshot?.bytes ?? 0,
        truncated: Boolean(version.truncated),
        revertedAt: version.revertedAt ?? null,
      })
    }
    points.reverse()
    return points.slice(0, Math.max(0, limit))
  }

  // --------------------------------------------------------------- capture

  /**
   * Snapshot the workspace and record it as a new immutable version.
   *
   * @param {object} options
   * @param {'baseline'|'before-chat-turn'|'toolcall'|'pre-revert'|'post-revert'} options.type
   * @param {number|null} [options.turn]
   * @param {string|null} [options.messageId]
   * @param {string} [options.label]      explicit commit label override
   * @param {string} [options.preview]    user message preview for the UI
   * @param {boolean} [options.force]
   */
  capture({ type, turn = null, messageId = null, label, preview = '', force = false } = {}) {
    this.ensureInit()
    const marker = MARKER_TYPES.includes(type)

    if (type === 'before-chat-turn' && turn !== null) {
      const existing = this.loadVersions().find(
        (entry) => entry.type === 'before-chat-turn' && entry.turn === turn,
      )
      if (existing && !force) return { skipped: true, reason: 'duplicate-turn', version: existing }
    }

    const scan = scanWorkspace(this.workspace, this.config)
    if (scan.error) throw new SnapshotError(scan.error, 'WORKSPACE_UNAVAILABLE')

    const latest = this.latestVersion()
    const previousManifest = this.latestManifest()
    const diff = diffManifests(previousManifest, scan.manifest)
    if (scan.truncated) {
      // A truncated walk cannot prove a file is missing; never treat it as deleted.
      diff.deleted = []
      diff.changed = diff.added.length + diff.modified.length
    }

    if (diff.changed === 0 && !marker && !force) {
      return { skipped: true, reason: 'no-changes', version: latest ?? null }
    }

    // Store changed file contents as content-addressed blobs first; a crash
    // before the tree is written just leaves a few unreferenced objects.
    const stored = { added: [], modified: [], deleted: diff.deleted }
    for (const repoPath of [...diff.added, ...diff.modified]) {
      const absolute = fromRepoPath(this.workspace, repoPath)
      let content
      try {
        content = fs.readFileSync(absolute)
      } catch {
        // The file vanished between scan and read: leave the old entry alone.
        this.log(`snapshot skipped vanished file ${repoPath}`, 'warn')
        continue
      }
      this.objects.put(content)
      if (diff.added.includes(repoPath)) stored.added.push(repoPath)
      else stored.modified.push(repoPath)
    }
    this._applyToBase(stored, diff)

    const manifest = scan.truncated
      ? mergeWithoutDeletes(previousManifest, scan.manifest, diff)
      : applyDiffManifest(previousManifest, scan.manifest, diff)
    // Drop entries whose blob never made it into the store (vanished files).
    for (const repoPath of Object.keys(manifest)) {
      if (!this.objects.has(manifest[repoPath].sha256)) {
        const previous = previousManifest[repoPath]
        if (previous && this.objects.has(previous.sha256)) manifest[repoPath] = previous
        else delete manifest[repoPath]
      }
    }

    const tree = buildTree(this.objects, manifest)
    const version = (latest?.version ?? 0) + 1
    const time = this.now()
    const commitLabel = label ?? defaultLabel(type, turn, messageId)
    const commit = commitIdOf({ parent: latest?.commit ?? null, tree, label: commitLabel, time })
    const record = {
      schemaVersion: 2,
      version,
      previousVersion: latest ? latest.version : null,
      commit,
      tree,
      parent: latest?.commit ?? null,
      branch: this.branch,
      type,
      label: commitLabel,
      turn,
      messageId,
      preview: preview || latest?.preview || '',
      time,
      createdAt: nowIso(),
      workspace: this.workspace,
      sessionId: this.sessionId,
      changed: {
        added: stored.added,
        modified: stored.modified,
        deleted: stored.deleted,
        changed: stored.added.length + stored.modified.length + stored.deleted.length,
      },
      stats: {
        files: Object.keys(manifest).length,
        bytes: scan.bytes,
        truncated: scan.truncated,
        skippedOversize: scan.skippedOversize,
      },
      truncated: scan.truncated,
    }
    writeJsonAtomic(versionFile(this.dir, version), record)
    writeJsonAtomic(this.latestFile, {
      version,
      commit,
      tree,
      type,
      turn,
      messageId,
      label: commitLabel,
      time,
      files: record.stats.files,
      changed: record.changed.changed,
    })
    this.invalidateCache()
    return record
  }

  /** Copy the changed workspace files into the repository worktree mirror. */
  _applyToBase(stored, diff) {
    for (const repoPath of [...stored.added, ...stored.modified]) {
      const source = fromRepoPath(this.workspace, repoPath)
      const target = path.join(this.baseDir, ...repoPath.split('/'))
      try {
        ensureDir(path.dirname(target))
        fs.copyFileSync(source, target)
      } catch {
        this.log(`base mirror copy failed for ${repoPath}`, 'warn')
      }
    }
    for (const repoPath of diff.deleted) {
      const target = path.join(this.baseDir, ...repoPath.split('/'))
      if (!pathExists(target)) continue
      const tombstone = path.join(this.diskDir, ...repoPath.split('/'))
      try {
        ensureDir(path.dirname(tombstone))
        fs.copyFileSync(target, tombstone)
      } catch {
        // tombstone is advisory only
      }
      fs.rmSync(target, { force: true })
    }
  }

  /** Patch the preview text of a rewind point after the user message lands. */
  updatePreview({ turn, preview }) {
    if (!preview) return
    const versions = this.loadVersions()
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      const entry = versions[index]
      if (entry.type !== 'before-chat-turn') continue
      if (turn !== null && turn !== undefined && entry.turn !== turn) continue
      if (entry.preview === preview) return
      writeJsonAtomic(versionFile(this.dir, entry.version), { ...entry, preview })
      return
    }
  }

  // ---------------------------------------------------------------- restore

  /**
   * Restore the workspace to a snapshot, then record the result as a new
   * baseline so later snapshots and rollbacks stay consistent.
   *
   * @param {object} options
   * @param {number|string} [options.target] version, commit/tree id or label
   * @param {boolean} [options.dryRun]
   * @param {'overwrite'|'skip'} [options.onConflict]
   * @param {boolean} [options.safety] take a pre-revert safety snapshot (default true)
   * @param {boolean} [options.resnapshot] record a post-revert baseline (default true)
   */
  restore({ target, dryRun = false, onConflict, safety = true, resnapshot = true } = {}) {
    this.ensureInit()
    const targetVersion = this.resolveTarget(target)
    if (!targetVersion) {
      throw new SnapshotError(`unknown rewind target: ${String(target)}`, 'UNKNOWN_TARGET')
    }
    const mode = onConflict === 'skip' || onConflict === 'overwrite'
      ? onConflict
      : (this.config.onConflict ?? 'overwrite')

    const scan = scanWorkspace(this.workspace, this.config)
    if (scan.error) throw new SnapshotError(scan.error, 'WORKSPACE_UNAVAILABLE')
    if (scan.truncated) {
      throw new SnapshotError(
        'workspace scan was truncated (too many/large files); refusing to roll back to avoid deleting unverified files',
        'SCAN_TRUNCATED',
      )
    }
    const targetManifest = this.manifestOfVersion(targetVersion)
    const latestManifest = this.latestManifest()
    const plan = planRestore({
      target: targetManifest,
      latest: latestManifest,
      current: scan.manifest,
    })

    const skipped = []
    const restoreList = []
    const removeList = []
    for (const item of plan.restore) {
      if (item.conflict && mode === 'skip') skipped.push({ path: item.path, reason: 'externally-modified' })
      else restoreList.push(item)
    }
    for (const item of plan.remove) {
      if (item.conflict && mode === 'skip') skipped.push({ path: item.path, reason: 'externally-modified' })
      else removeList.push(item)
    }

    const report = {
      ok: true,
      dryRun,
      target: {
        version: targetVersion.version,
        commit: targetVersion.commit,
        tree: targetVersion.tree,
        label: targetVersion.label,
        type: targetVersion.type,
        turn: targetVersion.turn ?? null,
        time: targetVersion.time,
      },
      workspace: this.workspace,
      restored: restoreList.map((item) => item.path),
      removed: removeList.map((item) => item.path),
      skipped,
      conflicts: plan.conflicts,
      unchanged: plan.unchanged,
      conflictPolicy: mode,
      safetyVersion: null,
      postVersion: null,
      warnings: [],
    }

    if (dryRun) return report

    if (safety) {
      const safetyRecord = this.capture({ type: 'pre-revert', label: `pre-revert-${this.now()}`, force: true })
      report.safetyVersion = safetyRecord?.version ?? null
    }

    for (const item of restoreList) {
      const fileMeta = targetManifest[item.path]
      const blob = fileMeta?.sha256 ?? fileMeta?.blob
      if (!blob) {
        report.warnings.push(`missing blob metadata for ${item.path}`)
        continue
      }
      let content
      try {
        content = this.objects.get(blob)
      } catch (error) {
        report.warnings.push(`cannot read blob for ${item.path}: ${error.message}`)
        continue
      }
      const absolute = fromRepoPath(this.workspace, item.path)
      ensureDir(path.dirname(absolute))
      fs.writeFileSync(absolute, content)
    }
    for (const item of removeList) {
      const absolute = fromRepoPath(this.workspace, item.path)
      fs.rmSync(absolute, { force: true })
      pruneEmptyParents(path.dirname(absolute), this.workspace)
    }

    if (resnapshot) {
      const postRecord = this.capture({ type: 'post-revert', label: `post-revert-${this.now()}`, force: true })
      report.postVersion = postRecord?.version ?? null
    }

    // Remember on the target point that it was used, for the UI.
    try {
      const fresh = this.readVersion(targetVersion.version)
      if (fresh) {
        writeJsonAtomic(versionFile(this.dir, fresh.version), {
          ...fresh,
          revertedAt: this.now(),
          revertCount: (fresh.revertCount ?? 0) + 1,
        })
      }
    } catch {
      // metadata is informative only
    }

    return report
  }

  // ------------------------------------------------------------- retention

  /**
   * Keep only the newest `keepTurns` rewind points; drop every older version
   * (toolcalls, safety points) except the baseline and the newest version.
   * This is what removes the unbounded tool-call metadata growth.
   */
  pruneVersions({ keepTurns = this.config.keepTurns } = {}) {
    const versions = this.loadVersions()
    if (!versions.length) return { removed: [], kept: 0 }
    const points = versions.filter((entry) => entry.type === 'before-chat-turn')
    const keptPoints = points.slice(Math.max(0, points.length - keepTurns))
    const cutoff = keptPoints.length ? keptPoints[0].version : versions[versions.length - 1].version
    const latestVersion = versions[versions.length - 1].version
    const removed = []
    for (const entry of versions) {
      if (entry.version >= cutoff) continue
      if (entry.type === 'baseline' || entry.type === 'init') continue
      if (entry.version === latestVersion) continue
      try {
        fs.rmSync(versionFile(this.dir, entry.version), { force: true })
        removed.push(entry.version)
      } catch {
        // ignore
      }
    }
    if (removed.length) this.invalidateCache()
    return { removed, kept: versions.length - removed.length }
  }

  /** Backwards-compatible alias. */
  prunePoints({ keepTurns = this.config.keepTurns } = {}) {
    const result = this.pruneVersions({ keepTurns })
    return { dropped: result.removed, kept: result.kept }
  }

  /**
   * Drop all but the newest `keepVersions` version files, then delete every
   * object (blob or tree node) no surviving version references any more.
   */
  maintenance({ keepVersions = 200, keepTurns } = {}) {
    if (keepTurns !== undefined) this.pruneVersions({ keepTurns })
    const versions = this.loadVersions()
    const droppedVersions = []
    if (versions.length > keepVersions) {
      for (const entry of versions.slice(0, versions.length - keepVersions)) {
        try {
          fs.rmSync(versionFile(this.dir, entry.version), { force: true })
          droppedVersions.push(entry.version)
        } catch {
          // ignore
        }
      }
      this.invalidateCache()
    }
    const remaining = this.loadVersions()
    const referenced = this.referencedObjectIds(remaining)
    const collected = this.objects.gc(referenced)
    this._treeCache.clear()
    return {
      versions: remaining.length,
      droppedVersions,
      removedObjects: collected.removed,
      freedBytes: collected.freed,
      diskBytes: dirSize(this.dir),
    }
  }

  /** Every tree id and blob id reachable from the surviving versions. */
  referencedObjectIds(versions = this.loadVersions()) {
    const treeIds = new Set()
    const blobIds = new Set()
    const visited = new Set()
    for (const version of versions) {
      if (version.tree) {
        try {
          collectTreeObjects(this.objects, version.tree, { treeIds, blobIds, visited })
        } catch (error) {
          this.log(`cannot walk tree of version ${version.version}: ${error.message}`, 'warn')
        }
      } else {
        for (const meta of Object.values(version.files ?? {})) {
          const blob = meta.sha256 ?? meta.blob
          if (blob) blobIds.add(blob)
        }
      }
    }
    return new Set([...treeIds, ...blobIds])
  }

  // ----------------------------------------------------------------- status

  status() {
    const latest = this.latestVersion()
    const versions = this.loadVersions()
    const points = versions.filter((entry) => entry.type === 'before-chat-turn')
    const objects = this.objects.size()
    const bytes = dirSize(this.dir)
    return {
      sessionId: this.sessionId,
      workspace: this.workspace,
      dir: this.dir,
      branch: this.branch,
      versions: versions.length,
      points: points.length,
      objects: objects.count,
      latest: latest
        ? {
            version: latest.version,
            commit: latest.commit,
            tree: latest.tree,
            label: latest.label,
            type: latest.type,
            time: latest.time,
            files: latest.stats?.files ?? latest.snapshot?.files ?? 0,
          }
        : null,
      diskBytes: bytes,
      diskLabel: formatBytes(bytes),
    }
  }
}

function defaultLabel(type, turn, messageId) {
  if (type === 'before-chat-turn') return `before-chat-turn-${turn}`
  if (type === 'toolcall') return `toolcall-${turn}-${messageId ?? 'unknown'}`
  return `${type}-${Date.now()}`
}

/** Merge a truncated scan without deleting anything. */
function mergeWithoutDeletes(previous, next, diff) {
  const manifest = { ...(previous ?? {}) }
  for (const repoPath of diff.added) manifest[repoPath] = { sha256: next[repoPath].sha256 }
  for (const repoPath of diff.modified) manifest[repoPath] = { sha256: next[repoPath].sha256 }
  return manifest
}

/** Apply a complete diff to a manifest of `{ sha256 }` entries. */
function applyDiffManifest(previous, next, diff) {
  const manifest = { ...(previous ?? {}) }
  for (const repoPath of diff.added) manifest[repoPath] = { sha256: next[repoPath].sha256 }
  for (const repoPath of diff.modified) manifest[repoPath] = { sha256: next[repoPath].sha256 }
  for (const repoPath of diff.deleted) delete manifest[repoPath]
  return manifest
}

function pruneEmptyParents(dir, root) {
  let current = dir
  while (current && current.startsWith(root) && current !== root) {
    try {
      if (fs.readdirSync(current).length > 0) return
      fs.rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}
