// Content-addressed object store for the hidden snapshot repository.
//
// Why not shell out to `git`? The original TRAE implementation keeps one hidden
// .git repository per session. DSH plugins can run in confined environments that
// do not allow spawning child processes (and users may not have git installed),
// so this module implements the one property the rewind feature actually needs:
// content-addressed blobs plus immutable per-snapshot manifests.
//
// Layout mirrors the TRAE v2 directory:
//   objects/<aa>/<rest>     zlib-deflated blobs, named by sha256 of content
//   base/content/<rel>      workspace mirror at the latest snapshot (debug aid)
//   disk/content/<rel>      last deleted copy (tombstone, advisory)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { ensureDir, pathExists, sha256 } from './util.js'

export class ObjectStore {
  constructor(root) {
    this.root = root
    this.dir = path.join(root, 'objects')
    ensureDir(this.dir)
  }

  objectPath(id) {
    const text = String(id ?? '')
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`invalid object id: ${text.slice(0, 20)}`)
    return path.join(this.dir, text.slice(0, 2), text.slice(2))
  }

  has(id) {
    try {
      return fs.statSync(this.objectPath(id)).isFile()
    } catch {
      return false
    }
  }

  /** Store a buffer once; returns its content id. */
  put(buffer) {
    const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8')
    const id = sha256(content)
    const target = this.objectPath(id)
    if (pathExists(target)) return id
    ensureDir(path.dirname(target))
    const deflated = zlib.deflateSync(content)
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    fs.writeFileSync(tmp, deflated)
    fs.renameSync(tmp, target)
    return id
  }

  /** Read a blob back; verifies the content hash so a corrupt store fails loudly. */
  get(id) {
    const deflated = fs.readFileSync(this.objectPath(id))
    const content = zlib.inflateSync(deflated)
    const actual = sha256(content)
    if (actual !== id) throw new Error(`snapshot object ${id} is corrupt (content hashes to ${actual})`)
    return content
  }

  /** Delete every object not present in `referenced`; returns reclaimed bytes. */
  gc(referenced) {
    const keep = referenced instanceof Set ? referenced : new Set(referenced)
    let removed = 0
    let freed = 0
    let buckets
    try {
      buckets = fs.readdirSync(this.dir, { withFileTypes: true })
    } catch {
      return { removed, freed }
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue
      const bucketDir = path.join(this.dir, bucket.name)
      let files
      try {
        files = fs.readdirSync(bucketDir)
      } catch {
        continue
      }
      for (const name of files) {
        const id = bucket.name + name
        const file = path.join(bucketDir, name)
        if (keep.has(id)) continue
        try {
          freed += fs.statSync(file).size
          fs.rmSync(file, { force: true })
          removed += 1
        } catch {
          // concurrent removal
        }
      }
    }
    return { removed, freed }
  }

  size() {
    let bytes = 0
    let count = 0
    const walk = (dir) => {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        try {
          if (entry.isDirectory()) walk(full)
          else if (entry.isFile()) {
            count += 1
            bytes += fs.statSync(full).size
          }
        } catch {
          // vanished
        }
      }
    }
    walk(this.dir)
    return { count, bytes }
  }
}

/** Deterministic tree id over a manifest (path + blob id, sorted). */
export function treeIdOf(files) {
  const hash = createHash('sha256')
  for (const repoPath of Object.keys(files).sort()) {
    hash.update(repoPath)
    hash.update('\u0000')
    hash.update(files[repoPath].blob)
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

/** Deterministic commit id: parent + tree + label + time, like a git commit. */
export function commitIdOf({ parent, tree, label, time }) {
  return sha256(`${parent ?? ''}\n${tree}\n${label}\n${time}`)
}
