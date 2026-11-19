// Global storage budget: FIFO eviction across every workspace store and the
// strict "one snapshot alone is bigger than the whole budget" fallback.
// These tests run real git and use incompressible random bytes so the on-disk
// size is predictable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { ShadowStore } from '../lib/shadow.js'
import { cleanup, gitSkipReason, makeTempDir, makeWorkspace, writeFiles } from './helpers.mjs'

const skip = gitSkipReason()

function makeStore(dataDir, maxTotalBytes, log = () => {}) {
  return new ShadowStore({
    config: resolveConfig({ dataDir, maxTotalBytes, autoMaintenance: { enabled: false } }),
    log,
  })
}

async function snapshot(store, workspace, sessionId, turn, seq) {
  return store.captureBeforeTurn({ cwd: workspace, sessionId, turn, seq })
}

test('global budget evicts the oldest snapshots of every workspace first', { skip }, async () => {
  const dataDir = makeTempDir('dsh-all-rewind-budget-')
  const workspaceA = makeWorkspace({ 'a.bin': randomBytes(600 * 1024) })
  const workspaceB = makeWorkspace({ 'b.bin': randomBytes(600 * 1024) })
  const cap = 2 * 1024 * 1024
  const store = makeStore(dataDir, cap)
  try {
    await snapshot(store, workspaceA, 'session-a', 1, 1) // oldest
    await snapshot(store, workspaceB, 'session-b', 1, 1)
    writeFiles(workspaceA, { 'a.bin': randomBytes(600 * 1024) })
    await snapshot(store, workspaceA, 'session-a', 2, 2)
    writeFiles(workspaceB, { 'b.bin': randomBytes(600 * 1024) })
    await snapshot(store, workspaceB, 'session-b', 2, 2)

    const status = await store.status()
    assert.ok(status.storage.diskBytes <= cap, `disk ${status.storage.diskBytes} must stay under ${cap}`)
    assert.equal(status.storage.maxBytes, cap)
    assert.ok(status.points >= 2 && status.points <= 3, `expected 2-3 retained snapshots, got ${status.points}`)

    const pointsA = store.points('session-a').map((point) => point.turn)
    const pointsB = store.points('session-b').map((point) => point.turn)
    assert.ok(!pointsA.includes(1), 'the oldest anchor (turn 1 of workspace A) was dropped first')
    assert.equal(pointsB[0], 2, 'the newest snapshot of workspace B is retained')

    // The kept anchors still point at real commits.
    for (const point of store.points('session-a').concat(store.points('session-b'))) {
      assert.match(point.commit, /^[0-9a-f]{40}$/)
    }
  } finally {
    cleanup(workspaceA, workspaceB, dataDir)
  }
})

test('a snapshot bigger than the whole budget is deleted and its workspace pauses', { skip }, async () => {
  const dataDir = makeTempDir('dsh-all-rewind-budget-')
  const workspace = makeWorkspace({ 'huge.bin': randomBytes(1500 * 1024) })
  const cap = 400 * 1024
  const logs = []
  const store = makeStore(dataDir, cap, (message, level) => logs.push({ message, level }))
  try {
    await snapshot(store, workspace, 'session-huge', 1, 1)

    const status = await store.status()
    assert.equal(status.points, 0, 'not even the newest snapshot is kept in strict mode')
    assert.ok(status.storage.diskBytes <= cap, `store must shrink below the cap, got ${status.storage.diskBytes}`)
    assert.equal(status.storage.pausedWorkspaces.length, 1)
    const paused = status.workspaces[0].paused
    assert.equal(paused.reason, 'snapshot-exceeds-budget')
    assert.ok(logs.some((entry) => entry.level === 'warn' && /exceeds the .* budget/.test(entry.message)))

    // Paused workspaces do not write another giant snapshot on the next turn.
    writeFiles(workspace, { 'huge.bin': randomBytes(1500 * 1024) })
    const before = status.storage.diskBytes
    const point = await snapshot(store, workspace, 'session-huge', 2, 2)
    assert.equal(point?.skipped, true)
    const after = (await store.status()).storage.diskBytes
    assert.equal(after, before, 'no objects were written while paused')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('a paused workspace only retries after its oversized tree shrinks', { skip }, async () => {
  const dataDir = makeTempDir('dsh-all-rewind-budget-')
  const workspace = makeWorkspace({ 'huge.bin': randomBytes(1500 * 1024) })
  const store = makeStore(dataDir, 400 * 1024)
  try {
    await snapshot(store, workspace, 'session-retry', 1, 1)
    const pausedWorkspace = await store.workspace(workspace)
    assert.equal(pausedWorkspace.state.paused.reason, 'snapshot-exceeds-budget')

    // Expire the retry window but keep the tree large: no bytes are written.
    pausedWorkspace.state.paused.at = Date.now() - 31 * 60_000
    pausedWorkspace.save()
    const before = (await store.status()).storage.diskBytes
    const skipped = await snapshot(store, workspace, 'session-retry', 2, 2)
    assert.equal(skipped?.skipped, true)
    assert.equal((await store.status()).storage.diskBytes, before)

    // Shrink the workspace: the retry is allowed again and the snapshot fits.
    fs.rmSync(path.join(workspace, 'huge.bin'))
    pausedWorkspace.state.paused.at = Date.now() - 31 * 60_000
    pausedWorkspace.save()
    const point = await snapshot(store, workspace, 'session-retry', 3, 3)
    assert.ok(point?.commit)
    const status = await store.status()
    assert.equal(status.storage.pausedWorkspaces.length, 0)
    assert.equal(status.storage.overBudget, false)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('raising maxTotalBytes lets a paused workspace snapshot again', { skip }, async () => {
  const dataDir = makeTempDir('dsh-all-rewind-budget-')
  const workspace = makeWorkspace({ 'huge.bin': randomBytes(1500 * 1024) })
  const store = makeStore(dataDir, 400 * 1024)
  try {
    await snapshot(store, workspace, 'session-raise', 1, 1)
    const pausedWorkspace = await store.workspace(workspace)
    assert.equal(pausedWorkspace.state.paused.reason, 'snapshot-exceeds-budget')

    pausedWorkspace.state.paused.at = Date.now() - 31 * 60_000
    pausedWorkspace.save()
    store.config.maxTotalBytes = 2 * 1024 * 1024

    const point = await snapshot(store, workspace, 'session-raise', 2, 2)
    assert.ok(point?.commit, 'the raised budget allows a new snapshot')
    const status = await store.status()
    assert.equal(status.storage.pausedWorkspaces.length, 0)
    assert.ok(status.storage.diskBytes <= 2 * 1024 * 1024)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('the budget is enforced across multiple sessions of one workspace', { skip }, async () => {
  const dataDir = makeTempDir('dsh-all-rewind-budget-')
  const workspace = makeWorkspace({ 'data.bin': randomBytes(400 * 1024) })
  const cap = 1024 * 1024
  const store = makeStore(dataDir, cap)
  try {
    await snapshot(store, workspace, 'session-1', 1, 1)
    writeFiles(workspace, { 'data.bin': randomBytes(400 * 1024) })
    await snapshot(store, workspace, 'session-1', 2, 2)
    writeFiles(workspace, { 'other.bin': randomBytes(400 * 1024) })
    await snapshot(store, workspace, 'session-2', 1, 1)
    writeFiles(workspace, { 'third.bin': randomBytes(400 * 1024) })
    await snapshot(store, workspace, 'session-2', 2, 2)

    const status = await store.status()
    assert.ok(status.storage.diskBytes <= cap, `disk ${status.storage.diskBytes} must stay under ${cap}`)
    assert.ok(status.points < 4, 'old anchors of the shared repository are evicted')
    assert.equal(fs.existsSync(path.join(dataDir, 'shadows')), true)
  } finally {
    cleanup(workspace, dataDir)
  }
})
