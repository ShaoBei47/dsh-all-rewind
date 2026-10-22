// Shared helpers for the test suite: a throwaway workspace + a real
// content-addressed snapshot store.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionSnapshotStore } from '../lib/store.js'
import { resolveConfig } from '../lib/config.js'

export function makeTempDir(prefix = 'dsh-all-rewind-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function makeWorkspace(files = {}) {
  const root = makeTempDir('dsh-all-rewind-ws-')
  writeFiles(root, files)
  return root
}

export function writeFiles(root, files = {}) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split('/'))
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
}

export function readFile(root, relative) {
  return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')
}

export function exists(root, relative) {
  return fs.existsSync(path.join(root, ...relative.split('/')))
}

export function removeFile(root, relative) {
  fs.rmSync(path.join(root, ...relative.split('/')), { force: true })
}

export function makeStore(workspace, overrides = {}) {
  const dataDir = overrides.dataDir ?? makeTempDir('dsh-all-rewind-data-')
  const config = resolveConfig({
    dataDir,
    keepTurns: 20,
    ...overrides,
  })
  const sessionId = overrides.sessionId ?? 'session-test-1'
  const store = new SessionSnapshotStore({
    dir: path.join(dataDir, 'snapshots', sessionId, 'v2'),
    sessionId,
    workspace,
    config,
    now: overrides.now ?? (() => Date.now()),
  })
  store.ensureInit()
  return { store, dataDir, config, sessionId }
}

export function labels(store) {
  return store.loadVersions().map((entry) => entry.label)
}

export function cleanup(...dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}
