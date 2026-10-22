import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { RewindManager } from '../lib/manager.js'
import { resolveConfig } from '../lib/config.js'
import {
  cleanup, exists, makeTempDir, makeWorkspace, readFile, removeFile, writeFiles,
} from './helpers.mjs'

function makeManager(workspace, overrides = {}) {
  const dataDir = overrides.dataDir ?? makeTempDir('dsh-all-rewind-mgr-')
  const config = resolveConfig({ dataDir, keepTurns: 20, ...overrides })
  if (overrides.autoMaintenance) config.autoMaintenance = overrides.autoMaintenance
  const logs = []
  const manager = new RewindManager({
    config,
    services: overrides.services ?? {},
    log: (message, level) => logs.push({ message, level }),
  })
  return { manager, dataDir, config, logs }
}

function makeSession(workspace, id = 'session-mgr-1') {
  return { id, header: { cwd: workspace } }
}

const writeToolCall = (sessionId, turn, callId, name = 'write') => [
  ['tool/call', { turn, step: 1, callId, name, arguments: '{}' }],
  ['tool/result', { turn, step: 1, message: { role: 'tool', toolCallId: callId, content: [] } }],
]

async function emitAll(manager, session, pairs) {
  for (const [type, data] of pairs) manager.onSessionEvent(session, { type, data, seq: 0, time: Date.now() })
  await manager.drain()
}

test('session/created records a baseline and sessions are listed', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'one', 'src/b.js': 'two' })
  const { manager, dataDir } = makeManager(workspace)
  try {
    const session = makeSession(workspace)
    manager.onSessionCreated(session)
    await manager.drain()
    const sessions = manager.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].sessionId, session.id)
    assert.equal(sessions[0].workspace, workspace)
    assert.equal(sessions[0].points, 1)
    const points = manager.points({ sessionId: session.id })
    assert.equal(points[0].type, 'baseline')
    assert.equal(points[0].files, 2)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('turn/start + tool/result produce TRAE-style anchors and toolcall snapshots', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'v0' })
  const { manager, dataDir } = makeManager(workspace)
  try {
    const session = makeSession(workspace)
    manager.onSessionCreated(session)
    await manager.drain()

    manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 }, seq: 1, time: Date.now() })
    await manager.drain()

    // User message text arrives for the point preview.
    manager.onSessionEvent(session, {
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '把 a.txt 改成 v1' }] },
      seq: 2,
      time: Date.now(),
    })
    await manager.drain()

    writeFiles(workspace, { 'a.txt': 'v1' })
    await emitAll(manager, session, writeToolCall(session.id, 1, 'call_1'))

    // Read-only tools must not create snapshots.
    const before = manager.points({ sessionId: session.id, includeToolcalls: true }).length
    await emitAll(manager, session, writeToolCall(session.id, 1, 'call_read', 'read'))
    const after = manager.points({ sessionId: session.id, includeToolcalls: true }).length
    assert.equal(after, before, 'read tool did not snapshot')

    const points = manager.points({ sessionId: session.id, includeToolcalls: true })
    const labels = points.map((point) => point.label)
    assert.ok(labels.includes('before-chat-turn-1'), 'turn anchor exists')
    assert.ok(labels.includes('toolcall-1-call_1'), 'toolcall snapshot exists')
    assert.ok(!labels.includes('toolcall-1-call_read'), 'read toolcall skipped')
    const turnPoint = points.find((point) => point.label === 'before-chat-turn-1')
    assert.equal(turnPoint.preview, '把 a.txt 改成 v1')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('manager.revert restores the workspace to before a turn', async () => {
  const workspace = makeWorkspace({ 'app.js': 'base' })
  const { manager, dataDir } = makeManager(workspace)
  try {
    const session = makeSession(workspace)
    manager.onSessionCreated(session)
    await manager.drain()

    // Turn 1 writes app.js.
    manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 }, seq: 1, time: Date.now() })
    await manager.drain()
    writeFiles(workspace, { 'app.js': 'turn1', 'created.js': 'turn1' })
    await emitAll(manager, session, writeToolCall(session.id, 1, 'call_1'))

    // Turn 2 starts, then writes more.
    manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 2 }, seq: 3, time: Date.now() })
    await manager.drain()
    writeFiles(workspace, { 'app.js': 'turn2' })
    await emitAll(manager, session, writeToolCall(session.id, 2, 'call_2'))
    assert.equal(readFile(workspace, 'app.js'), 'turn2')

    const turn2 = manager.points({ sessionId: session.id }).find((point) => point.turn === 2)
    const report = manager.revert({ sessionId: session.id, target: turn2.version })
    assert.equal(report.dryRun, false)
    assert.equal(readFile(workspace, 'app.js'), 'turn1')
    assert.equal(exists(workspace, 'created.js'), true)

    const turn1 = manager.points({ sessionId: session.id }).find((point) => point.turn === 1)
    manager.revert({ sessionId: session.id, target: turn1.version })
    assert.equal(readFile(workspace, 'app.js'), 'base')
    assert.equal(exists(workspace, 'created.js'), false)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('read-only sandbox sessions refuse to roll back unless forced', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'one' })
  const { manager, dataDir } = makeManager(workspace, {
    services: {
      sessions: { get: () => ({ id: 'session-mgr-1' }) },
      sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: workspace }) },
    },
  })
  try {
    const session = makeSession(workspace)
    manager.onSessionCreated(session)
    await manager.drain()
    manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 }, seq: 1, time: Date.now() })
    await manager.drain()
    writeFiles(workspace, { 'a.txt': 'two' })
    await emitAll(manager, session, writeToolCall(session.id, 1, 'call_1'))

    const target = manager.points({ sessionId: session.id }).find((point) => point.turn === 1)
    assert.throws(() => manager.revert({ sessionId: session.id, target: target.version }), (error) => {
      assert.equal(error.code, 'READ_ONLY_SESSION')
      return true
    })
    assert.equal(readFile(workspace, 'a.txt'), 'two')
    // force bypasses the guard
    manager.revert({ sessionId: session.id, target: target.version, force: true })
    assert.equal(readFile(workspace, 'a.txt'), 'one')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('revert reports unknown sessions clearly', () => {
  const workspace = makeWorkspace({ 'a.txt': 'one' })
  const { manager, dataDir } = makeManager(workspace)
  try {
    assert.throws(
      () => manager.revert({ sessionId: 'session-missing', target: 1 }),
      /no snapshot repository/i,
    )
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('prune and maintenance operate over all snapshot repositories', async () => {
  const workspace = makeWorkspace({ 'a.txt': '0' })
  const { manager, dataDir } = makeManager(workspace, { keepTurns: 2 })
  try {
    const session = makeSession(workspace)
    manager.onSessionCreated(session)
    await manager.drain()
    for (let turn = 1; turn <= 4; turn += 1) {
      manager.onSessionEvent(session, { type: 'turn/start', data: { turn }, seq: turn, time: Date.now() })
      await manager.drain()
      writeFiles(workspace, { 'a.txt': String(turn) })
      await emitAll(manager, session, writeToolCall(session.id, turn, `call_${turn}`))
    }
    // Each new turn auto-prunes to `keepTurns`, so only 2 points stay visible.
    const visible = manager.points({ sessionId: session.id }).filter((point) => point.type === 'before-chat-turn')
    assert.equal(visible.length, 2)
    const pruned = manager.prune({ sessionId: session.id })
    assert.equal(pruned.sessions, 1)
    const maintenance = manager.maintenance({ sessionId: session.id, keepVersions: 3 })
    assert.equal(maintenance.sessions, 1)
    assert.ok(Array.isArray(maintenance.results))
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('sessions without an absolute cwd are skipped instead of failing', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'one' })
  const { manager, dataDir } = makeManager(workspace)
  try {
    const session = { id: 'session-no-cwd', header: {} }
    manager.onSessionCreated(session)
    await manager.drain()
    assert.equal(manager.listSessions().length, 0)
    // Events for that session must be ignored without throwing.
    manager.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 }, seq: 1, time: Date.now() })
    await manager.drain()
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('status exposes configuration and repository accounting', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'one' })
  const { manager, dataDir } = makeManager(workspace)
  try {
    manager.onSessionCreated(makeSession(workspace))
    await manager.drain()
    const status = manager.status()
    assert.equal(status.plugin, 'dsh-all-rewind')
    assert.equal(status.sessions, 1)
    assert.ok(status.points >= 1)
    assert.equal(status.config.keepTurns, 20)
    assert.ok(status.storage.dataDir)
    assert.equal(status.storage.snapshotsDir, path.join(dataDir, 'snapshots'))
    assert.ok(status.storage.diskBytes > 0)
    assert.equal(status.backend, 'content-addressed-trees')
  } finally {
    cleanup(workspace, dataDir)
  }
})


test('auto maintenance runs when the repository exceeds the threshold', async () => {
  const workspace = makeWorkspace({ 'blob.bin': 'x'.repeat(64 * 1024) })
  const { manager, dataDir, logs } = makeManager(workspace, {
    autoMaintenance: { enabled: true, thresholdBytes: 1, checkEveryTurns: 1, keepVersions: 4 },
  })
  try {
    const session = makeSession(workspace)
    manager.onSessionCreated(session)
    await manager.drain()
    for (let turn = 1; turn <= 4; turn += 1) {
      manager.onSessionEvent(session, { type: 'turn/start', data: { turn }, seq: turn, time: Date.now() })
      await manager.drain()
      writeFiles(workspace, { 'blob.bin': `${turn}-`.repeat(32 * 1024) })
      await emitAll(manager, session, writeToolCall(session.id, turn, `call_${turn}`))
    }
    assert.ok(logs.some((entry) => entry.message.includes('auto maintenance')), 'auto maintenance logged')
    const store = manager.storeForId(session.id)
    assert.ok(store.loadVersions().length <= 6, `versions bounded by keepVersions, got ${store.loadVersions().length}`)
    assert.ok(store.status().diskBytes > 0)
  } finally {
    cleanup(workspace, dataDir)
  }
})
