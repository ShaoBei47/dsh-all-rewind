// Small, dependency-free helpers shared by the snapshot engine.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** sha256 of a Buffer/string; used as the manifest content key. */
export function sha256(input) {
  const hash = createHash('sha256')
  hash.update(input)
  return hash.digest('hex')
}

/** sha256 of a file, streamed so large files do not need one big allocation. */
export function sha256File(file, chunkSize = 1 << 20) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(chunkSize)
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, chunkSize, null)) > 0) {
      hash.update(buf.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** Turn 'a/b' style repository-relative paths into a stable key. */
export function toPosix(p) {
  return String(p).split(path.sep).join('/')
}

/** Repository key (posix, no leading slash) from an absolute workspace path. */
export function toRepoPath(workspaceRoot, absolute) {
  return toPosix(path.relative(workspaceRoot, absolute))
}

/** Absolute path from a repository key. */
export function fromRepoPath(workspaceRoot, repoPath) {
  return path.join(workspaceRoot, ...String(repoPath).split('/'))
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** Write JSON atomically: temp file + rename, so a crash never leaves half a manifest. */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function pathExists(file) {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

export function isDirectory(file) {
  try {
    return fs.lstatSync(file).isDirectory()
  } catch {
    return false
  }
}

/** Human readable byte size (snapshot dirs can get large; TRAE has the same problem). */
export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = Number(bytes) || 0
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Total size of a directory tree (best effort; used by status/prune output). */
export function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirSize(full)
      else if (entry.isFile()) total += fs.statSync(full).size
    } catch {
      // A file that vanished mid-walk contributes zero.
    }
  }
  return total
}

/** Only keep characters that are safe on every filesystem (session ids, call ids). */
export function sanitizeSegment(input) {
  const text = String(input ?? '')
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.slice(0, 120) || 'session'
}

/** Short stable display id for UI lists. */
export function shortId(input, length = 8) {
  const text = String(input ?? '')
  return text.length <= length ? text : text.slice(0, length)
}

/** Extract a compact text preview from a DSH message content block array. */
export function messagePreview(message, maxLength = 120) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`
}

/** Error to log without leaking stack noise into event handlers. */
export function errorMessage(error) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

/** Simple per-key serial queue: snapshot writes for one session never interleave. */
export class KeyedQueue {
  constructor() {
    this.tails = new Map()
  }

  run(key, task) {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    // Keep the chain alive but never let a rejection poison the key.
    this.tails.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  get pending() {
    let count = 0
    for (const tail of this.tails.values()) {
      if (tail) count += 1
    }
    return count
  }
}
