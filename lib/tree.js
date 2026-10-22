// Content-addressed directory trees.
//
// This is the structural-sharing layer that replaces the old "full file list in
// every version_file" design. A tree node is a small JSON document:
//
//   { "f": { "app.js": "<blob sha256>" }, "d": { "src": "<child tree sha256>" } }
//
// Serialized with sorted keys it is deterministic, so it can be stored in the
// same content-addressed object store as file contents. Consequences:
//
//   * an unchanged directory (or file) is referenced by the same tree id in
//     every snapshot, so a version only adds tree nodes along the changed paths;
//   * restoring/listing a version just walks its root tree id — no parent chain,
//     no duplicated manifest, no per-version file list on disk;
//   * garbage collection becomes "walk the trees of surviving versions".
import { sha256 } from './util.js'

const EMPTY_TREE = '{"d":{},"f":{}}'

function sortedObject(object) {
  const result = {}
  for (const key of Object.keys(object).sort()) result[key] = object[key]
  return result
}

function serialize({ files, dirs }) {
  return JSON.stringify({ d: sortedObject(dirs), f: sortedObject(files) })
}

/** Store one tree node (deduplicated by content) and return its id. */
function putTree(objects, node) {
  return objects.put(Buffer.from(serialize(node), 'utf8'))
}

/**
 * Build the root tree id for a manifest (repoPath -> { sha256 }).
 * Unchanged subtrees collapse to the same ids as previous snapshots.
 */
export function buildTree(objects, manifest) {
  const root = { files: {}, dirs: {} }
  const nodes = new Map([[root, true]])
  for (const [repoPath, entry] of Object.entries(manifest ?? {})) {
    const parts = repoPath.split('/')
    let current = root
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index]
      let child = current.dirs[part]
      if (!child) {
        child = { files: {}, dirs: {} }
        current.dirs[part] = child
      }
      current = child
    }
    const name = parts[parts.length - 1]
    const blob = entry.sha256 ?? entry.blob
    if (!blob) continue
    current.files[name] = blob
  }
  return finalize(objects, root)
}

function finalize(objects, node) {
  const dirs = {}
  for (const [name, child] of Object.entries(node.dirs)) {
    dirs[name] = finalize(objects, child)
  }
  return putTree(objects, { files: node.files, dirs })
}

/** Read + parse one tree node (throws when the object is missing/corrupt). */
export function readTree(objects, id) {
  const parsed = JSON.parse(objects.get(id).toString('utf8'))
  return { files: parsed.f ?? {}, dirs: parsed.d ?? {} }
}

/**
 * Flatten a tree into `repoPath -> { sha256 }`.
 * `cache` is an optional Map id -> parsed node reused across calls.
 */
export function enumerateTree(objects, rootId, { cache } = {}) {
  const manifest = {}
  const walk = (treeId, prefix) => {
    let node = cache?.get(treeId)
    if (!node) {
      node = readTree(objects, treeId)
      cache?.set(treeId, node)
    }
    for (const [name, blob] of Object.entries(node.files)) {
      manifest[prefix ? `${prefix}/${name}` : name] = { sha256: blob }
    }
    for (const [name, childId] of Object.entries(node.dirs)) {
      walk(childId, prefix ? `${prefix}/${name}` : name)
    }
  }
  walk(rootId, '')
  return manifest
}

/**
 * Collect every tree id and blob id reachable from a root tree, for GC.
 * Shared subtrees are visited once even when several versions reference them.
 */
export function collectTreeObjects(objects, rootId, { treeIds, blobIds, visited = new Set() } = {}) {
  if (!rootId || visited.has(rootId)) return
  visited.add(rootId)
  treeIds?.add(rootId)
  const node = readTree(objects, rootId)
  for (const blob of Object.values(node.files)) blobIds?.add(blob)
  for (const childId of Object.values(node.dirs)) {
    collectTreeObjects(objects, childId, { treeIds, blobIds, visited })
  }
}

/** Deterministic id of an (empty) tree, useful for tests/diagnostics. */
export const EMPTY_TREE_ID = sha256(EMPTY_TREE)
