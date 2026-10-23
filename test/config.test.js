// Configuration resolution: shadow-repository storage location + git and
// conversation knobs.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { defaultDataDir, dshHome, resolveConfig, resolveDataDir } from '../lib/config.js'
import { cleanup, makeTempDir } from './helpers.mjs'

function withEnv(patch, fn) {
  const previous = {}
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key]
    if (patch[key] === undefined) delete process.env[key]
    else process.env[key] = patch[key]
  }
  try {
    return fn()
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

test('default storage location is $DSH_HOME/dsh-all-rewind', () => {
  withEnv({ DSH_HOME: 'F:/fake-dsh-home', DSH_ALL_REWIND_DIR: undefined }, () => {
    assert.equal(dshHome(), 'F:/fake-dsh-home')
    assert.equal(defaultDataDir(), path.join('F:/fake-dsh-home', 'dsh-all-rewind'))
    assert.equal(resolveDataDir(undefined), defaultDataDir())
    assert.equal(resolveConfig({}).dataDir, defaultDataDir())
  })
})

test('DSH_ALL_REWIND_DIR overrides the default but not an explicit config value', () => {
  withEnv({ DSH_HOME: 'F:/fake-dsh-home', DSH_ALL_REWIND_DIR: 'G:/rewind-repo' }, () => {
    assert.equal(resolveDataDir(undefined), path.normalize('G:/rewind-repo'))
    // Explicit config wins over the environment variable.
    assert.equal(resolveDataDir('E:/explicit'), path.normalize('E:/explicit'))
  })
})

test('tilde and relative paths are expanded', () => {
  withEnv({ DSH_HOME: 'F:/fake-dsh-home', DSH_ALL_REWIND_DIR: undefined }, () => {
    assert.equal(resolveDataDir('~/rewind'), path.join(os.homedir(), 'rewind'))
    assert.equal(resolveDataDir('cache/rewind'), path.join('F:/fake-dsh-home', 'cache', 'rewind'))
  })
})

test('resolved config exposes git, conversation and maintenance defaults', () => {
  withEnv({ DSH_HOME: 'F:/fake-dsh-home', DSH_ALL_REWIND_DIR: undefined }, () => {
    const config = resolveConfig({ dataDir: 'H:/rewind-repo' })
    assert.equal(config.dataDir, path.normalize('H:/rewind-repo'))
    assert.equal(config.keepTurns, 20)
    assert.equal(config.gitExecutable, 'git')
    assert.equal(config.gitTimeoutMs, 120_000)
    assert.equal(config.conversation.enabled, true)
    assert.equal(config.respectSandboxPolicy, true)
    assert.equal(config.autoMaintenance.enabled, true)
    assert.equal(config.autoMaintenance.thresholdBytes, 512 * 1024 * 1024)
    assert.equal(config.autoMaintenance.checkEveryTurns, 5)
    assert.ok(config.ignoreDirs.includes('node_modules/'))
    assert.ok(config.ignoreDirs.includes('dist/'))

    const custom = resolveConfig({
      dataDir: 'H:/rewind-repo',
      keepTurns: 5,
      gitExecutable: 'C:/Program Files/Git/cmd/git.exe',
      gitTimeoutMs: 5000,
      conversation: { enabled: false },
      respectSandboxPolicy: false,
      autoMaintenance: { enabled: false, thresholdBytes: 20 * 1024 * 1024, checkEveryTurns: 1 },
      ignoreDirs: ['custom-cache'],
      exclude: ['*.snap'],
    })
    assert.equal(custom.keepTurns, 5)
    assert.equal(custom.gitExecutable, 'C:/Program Files/Git/cmd/git.exe')
    assert.equal(custom.gitTimeoutMs, 5000)
    assert.equal(custom.conversation.enabled, false)
    assert.equal(custom.respectSandboxPolicy, false)
    assert.equal(custom.autoMaintenance.enabled, false)
    assert.equal(custom.autoMaintenance.thresholdBytes, 20 * 1024 * 1024)
    assert.ok(custom.ignoreDirs.includes('custom-cache'))
    assert.deepEqual(custom.extraExcludes, ['*.snap'])
  })
})

test('config.dataDir is honoured by the store directory layout', () => {
  const customDir = makeTempDir('dsh-all-rewind-custom-')
  try {
    const resolved = resolveConfig({ dataDir: customDir })
    assert.equal(resolved.dataDir, path.normalize(customDir))
  } finally {
    cleanup(customDir)
  }
})

test('legacy DSH_TRAE_REWIND_DIR is still honoured during the rename', () => {
  withEnv(
    { DSH_HOME: 'F:/fake-dsh-home', DSH_ALL_REWIND_DIR: undefined, DSH_TRAE_REWIND_DIR: 'G:/legacy-snapshots' },
    () => {
      assert.equal(resolveDataDir(undefined), path.normalize('G:/legacy-snapshots'))
      // Explicit config still wins over both env vars.
      assert.equal(resolveDataDir('E:/explicit'), path.normalize('E:/explicit'))
    },
  )
  withEnv(
    { DSH_HOME: 'F:/fake-dsh-home', DSH_ALL_REWIND_DIR: 'E:/new-snapshots', DSH_TRAE_REWIND_DIR: 'G:/legacy-snapshots' },
    () => {
      assert.equal(resolveDataDir(undefined), path.normalize('E:/new-snapshots'))
    },
  )
})

test('out-of-range numbers are clamped instead of rejected', () => {
  const config = resolveConfig({
    keepTurns: -4,
    gitTimeoutMs: 1,
    autoMaintenance: { thresholdBytes: 1, checkEveryTurns: 999 },
  })
  assert.equal(config.keepTurns, 1)
  assert.equal(config.gitTimeoutMs, 5000)
  assert.equal(config.autoMaintenance.thresholdBytes, 8 * 1024 * 1024)
  assert.equal(config.autoMaintenance.checkEveryTurns, 100)
})
