// Configuration resolution: snapshot storage location + auto maintenance knobs.
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
  withEnv({ DSH_HOME: 'F:/fake-dsh-home', DSH_ALL_REWIND_DIR: 'G:/snapshots' }, () => {
    assert.equal(resolveDataDir(undefined), path.normalize('G:/snapshots'))
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

test('resolved config exposes storage + auto maintenance defaults', () => {
  withEnv({ DSH_HOME: 'F:/fake-dsh-home', DSH_ALL_REWIND_DIR: undefined }, () => {
    const config = resolveConfig({ dataDir: 'H:/snapshots' })
    assert.equal(config.dataDir, path.normalize('H:/snapshots'))
    assert.equal(config.keepTurns, 20)
    assert.equal(config.autoMaintenance.enabled, true)
    assert.equal(config.autoMaintenance.thresholdBytes, 128 * 1024 * 1024)
    assert.equal(config.autoMaintenance.checkEveryTurns, 3)
    assert.equal(config.autoMaintenance.keepVersions, 200)

    const custom = resolveConfig({
      keepTurns: 5,
      autoMaintenance: { enabled: false, thresholdBytes: 20 * 1024 * 1024, checkEveryTurns: 1, keepVersions: 50 },
    })
    assert.equal(custom.keepTurns, 5)
    assert.equal(custom.autoMaintenance.enabled, false)
    assert.equal(custom.autoMaintenance.thresholdBytes, 20 * 1024 * 1024)
    assert.equal(custom.autoMaintenance.keepVersions, 50)
  })
})

test('config.dataDir is honoured by the manager/plugin directory layout', () => {
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
