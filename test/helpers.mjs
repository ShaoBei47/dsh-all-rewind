// Shared helpers for the test suite: throwaway workspaces, temp data dirs and a
// real shadow-git store (git is a hard requirement of the plugin; tests skip
// only when the machine genuinely has no git).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { ShadowStore } from '../lib/shadow.js'

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

let cachedGit
/** Whether the machine has a usable git (2.13+). */
export function gitAvailable() {
  if (cachedGit !== undefined) return cachedGit
  try {
    const result = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000 })
    const match = /git version (\d+)\.(\d+)/.exec(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    if (result.status !== 0 || !match) {
      cachedGit = false
      return cachedGit
    }
    const major = Number(match[1])
    const minor = Number(match[2])
    cachedGit = major > 2 || (major === 2 && minor >= 13)
  } catch {
    cachedGit = false
  }
  return cachedGit
}

/** Skip reason for node:test. */
export function gitSkipReason() {
  return gitAvailable() ? undefined : 'git 2.13+ is not installed'
}

export function makeShadowStore(overrides = {}) {
  const dataDir = overrides.dataDir ?? makeTempDir('dsh-all-rewind-data-')
  const config = resolveConfig({
    dataDir,
    keepTurns: 20,
    autoMaintenance: { enabled: false },
    ...overrides,
  })
  const store = new ShadowStore({ config, log: overrides.log ?? (() => {}) })
  return { store, dataDir, config }
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

/** Session-like object accepted by the manager hooks. */
export function fakeSession(sessionId, workspace, extraHeader = {}) {
  return {
    id: sessionId,
    header: {
      id: sessionId,
      cwd: workspace,
      isSeeded: false,
      ...extraHeader,
    },
  }
}
