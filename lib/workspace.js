// Workspace scanner and manifest differ.
//
// A manifest is a plain object: repoPath -> { sha256, size, mtimeMs }.
//   - sha256 is our own content key: it lets restore compare the on-disk file
//     with the snapshot without shelling out to git for every path.
//   - git supplies the blob id at commit time (content-addressed dedupe).
import fs from 'node:fs'
import path from 'node:path'
import { sha256File, toPosix } from './util.js'

export const DEFAULT_IGNORE_DIRS = Object.freeze([
  '.git',
  '.hg',
  '.svn',
  '.dsh-rewind',
  '.tmp',
  '.cache',
  '.temp',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
])

export const DEFAULT_IGNORE_FILES = Object.freeze([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
])

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 // 1 MiB
export const DEFAULT_MAX_FILES = 8000
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024

function toSet(values) {
  return new Set((values ?? []).map((value) => String(value).toLowerCase()))
}

/**
 * Walk a workspace and hash every regular file that passes the ignore rules.
 *
 * @returns {{ manifest: Record<string, {sha256: string, size: number, mtimeMs: number}>,
 *             truncated: boolean, skippedOversize: number, files: number, bytes: number }}
 */
export function scanWorkspace(workspace, config = {}) {
  const ignoreDirs = toSet([...DEFAULT_IGNORE_DIRS, ...(config.ignoreDirs ?? [])])
  const ignoreFiles = toSet([...DEFAULT_IGNORE_FILES, ...(config.ignoreFiles ?? [])])
  const maxFileBytes = Number(config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
  const maxFiles = Number(config.maxFiles ?? DEFAULT_MAX_FILES)
  const maxTotalBytes = Number(config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)
  const manifest = {}
  let truncated = false
  let skippedOversize = 0
  let files = 0
  let bytes = 0

  const walk = (absoluteDir, repoDir) => {
    if (truncated) return
    let entries
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      return
    }
    // Deterministic order keeps manifests and tests reproducible.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (truncated) return
      if (entry.name.startsWith('.git') && entry.isDirectory()) continue
      const absolute = path.join(absoluteDir, entry.name)
      const repoPath = repoDir ? `${repoDir}/${entry.name}` : entry.name
      let stat
      try {
        stat = fs.lstatSync(absolute)
      } catch {
        continue
      }
      // Symlinks/junctions are never followed or snapshotted: restoring through
      // them could write outside the workspace.
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (ignoreDirs.has(entry.name.toLowerCase())) continue
        walk(absolute, repoPath)
        continue
      }
      if (!stat.isFile()) continue
      if (ignoreFiles.has(entry.name.toLowerCase())) continue
      if (stat.size > maxFileBytes) {
        skippedOversize += 1
        continue
      }
      if (files >= maxFiles || bytes + stat.size > maxTotalBytes) {
        truncated = true
        return
      }
      let sha
      try {
        sha = sha256File(absolute)
      } catch {
        continue
      }
      manifest[toPosix(repoPath)] = { sha256: sha, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
      files += 1
      bytes += stat.size
    }
  }

  try {
    if (!fs.statSync(workspace).isDirectory()) {
      return { manifest, truncated: false, skippedOversize: 0, files: 0, bytes: 0, error: 'workspace is not a directory' }
    }
  } catch (error) {
    return { manifest, truncated: false, skippedOversize: 0, files: 0, bytes: 0, error: `workspace unavailable: ${error.message}` }
  }

  walk(workspace, '')
  return { manifest, truncated, skippedOversize, files, bytes }
}

/** Compare two manifests: what appeared, changed and disappeared. */
export function diffManifests(previous, next) {
  const added = []
  const modified = []
  const deleted = []
  const prev = previous ?? {}
  for (const [repoPath, entry] of Object.entries(next)) {
    const before = prev[repoPath]
    if (!before) added.push(repoPath)
    else if (before.sha256 !== entry.sha256) modified.push(repoPath)
  }
  for (const repoPath of Object.keys(prev)) {
    if (!(repoPath in next)) deleted.push(repoPath)
  }
  added.sort()
  modified.sort()
  deleted.sort()
  return { added, modified, deleted, changed: added.length + modified.length + deleted.length }
}

/** Merge a previous manifest with a changed file set to produce the next manifest. */
export function applyDiff(previous, next, diff) {
  const manifest = { ...(previous ?? {}) }
  for (const repoPath of diff.added) manifest[repoPath] = next[repoPath]
  for (const repoPath of diff.modified) manifest[repoPath] = next[repoPath]
  for (const repoPath of diff.deleted) delete manifest[repoPath]
  return manifest
}

/**
 * Plan a restore of `target` over the current on-disk state.
 *
 * `latest` is the newest snapshot manifest: it is the authority for "files the
 * AI created". Files on disk that no snapshot ever saw are left untouched so a
 * rollback never eats untracked user work.
 *
 * @returns {{restore: Array<{path: string, reason: string, conflict: boolean}>,
 *            remove: Array<{path: string, reason: string, conflict: boolean}>,
 *            unchanged: number, conflicts: Array<{path: string, action: string}> }}
 */
export function planRestore({ target, latest, current }) {
  const restore = []
  const remove = []
  const conflicts = []
  let unchanged = 0
  const latestManifest = latest ?? {}

  for (const [repoPath, desired] of Object.entries(target ?? {})) {
    const now = current[repoPath]
    const trackedNow = latestManifest[repoPath]
    const externallyModified = Boolean(now && trackedNow && now.sha256 !== trackedNow.sha256)
    if (!now) {
      restore.push({ path: repoPath, reason: 'missing', conflict: false })
      continue
    }
    if (now.sha256 === desired.sha256) {
      unchanged += 1
      continue
    }
    restore.push({
      path: repoPath,
      reason: trackedNow ? 'modified' : 'untracked-collision',
      conflict: externallyModified,
    })
    if (externallyModified) conflicts.push({ path: repoPath, action: 'restore' })
  }

  for (const repoPath of Object.keys(latestManifest)) {
    if (repoPath in (target ?? {})) continue
    const now = current[repoPath]
    if (!now) continue // already gone
    const externallyModified = now.sha256 !== latestManifest[repoPath].sha256
    remove.push({ path: repoPath, reason: 'created-after-target', conflict: externallyModified })
    if (externallyModified) conflicts.push({ path: repoPath, action: 'remove' })
  }

  return { restore, remove, unchanged, conflicts }
}
