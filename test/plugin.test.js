import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import plugin, { injectUiTag, managerOf, registerTools, TOOL_NAMES } from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'
import {
  cleanup, exists, makeTempDir, makeWorkspace, readFile, writeFiles,
} from './helpers.mjs'
import { callRoute, createFakeContext, createMockRequest } from './fake-context.mjs'

const DEFAULT_CONFIG = { keepTurns: 20 }

function boot(options = {}) {
  const workspace = options.workspace ?? makeWorkspace({ 'a.txt': 'v0', 'src/app.js': 'base' })
  const dataDir = options.dataDir ?? makeTempDir('dsh-all-rewind-plugin-')
  const fake = createFakeContext(options.services ?? {})
  plugin.apply(fake.ctx, { ...DEFAULT_CONFIG, dataDir })
  const manager = managerOf(fake.ctx)
  const session = { id: options.sessionId ?? 'session-plugin-1', header: { cwd: workspace } }
  return { ...fake, manager, workspace, dataDir, session }
}

async function waitFor(manager) {
  await manager.drain()
}

async function seedTurn(harness, turn, { write = {}, callId = `call_${turn}`, tool = 'write' } = {}) {
  harness.ctx.emit('session/event', harness.session, { type: 'turn/start', data: { turn }, seq: turn, time: Date.now() })
  await waitFor(harness.manager)
  harness.ctx.emit('session/event', harness.session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: `第 ${turn} 轮：改文件` }] },
    seq: turn,
    time: Date.now(),
  })
  await waitFor(harness.manager)
  if (Object.keys(write).length) writeFiles(harness.workspace, write)
  harness.ctx.emit('session/event', harness.session, {
    type: 'tool/call',
    data: { turn, step: 1, callId, name: tool, arguments: '{}' },
    seq: turn,
    time: Date.now(),
  })
  harness.ctx.emit('session/event', harness.session, {
    type: 'tool/result',
    data: { turn, step: 1, message: { role: 'tool', toolCallId: callId, content: [] } },
    seq: turn,
    time: Date.now(),
  })
  await waitFor(harness.manager)
}

test('plugin registers its tools, routes and UI injection with a Cordis-like context', () => {
  const harness = boot()
  try {
    for (const toolName of TOOL_NAMES) {
      assert.ok(harness.tools.has(toolName), `tool ${toolName} registered`)
      const definition = harness.tools.get(toolName)
      assert.equal(typeof definition.execute, 'function')
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(definition.parameters.type, 'object')
    }
    assert.ok(harness.routes.has('/dsh-all-rewind/api/status'))
    assert.ok(harness.routes.has('/dsh-all-rewind/api/sessions'))
    assert.ok(harness.routes.has('/dsh-all-rewind/api/points'))
    assert.ok(harness.routes.has('/dsh-all-rewind/api/revert'))
    assert.ok(harness.routes.has('/dsh-all-rewind/ui.js'))
    assert.equal(harness.taps.length, 1)
    assert.ok(harness.taps[0]('<html><body></body></html>').includes('/dsh-all-rewind/ui.js'))
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('electron index-injection row is added once and carries the UI loader', () => {
  const harness = boot()
  try {
    const table = []
    harness.ctx.emit('webserver/index-inject', table)
    harness.ctx.emit('webserver/index-inject', table)
    assert.equal(table.length, 1)
    assert.equal(table[0].kind, 'script')
    assert.equal(table[0].placement, 'body')
    assert.ok(table[0].text.includes('/dsh-all-rewind/ui.js'))
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('injectUiTag is idempotent', () => {
  const html = '<html><body>app</body></html>'
  const once = injectUiTag(html)
  assert.ok(once.includes('/dsh-all-rewind/ui.js'))
  assert.equal(injectUiTag(once), once)
})

test('full flow: snapshots from session events, rollback through the host tool', async () => {
  const harness = boot()
  try {
    harness.ctx.emit('session/created', harness.session)
    await waitFor(harness.manager)

    await seedTurn(harness, 1, { write: { 'a.txt': 'v1', 'new.txt': 'created' } })
    await seedTurn(harness, 2, { write: { 'a.txt': 'v2' } })
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v2')

    const tool = harness.tools.get('rewind_list')
    const listed = await tool.execute({}, { agent: { id: harness.session.id } })
    assert.equal(listed.sessionId, harness.session.id)
    const turn2 = listed.points.find((point) => point.turn === 2)
    assert.ok(turn2, 'turn 2 point listed')
    assert.equal(turn2.preview, '第 2 轮：改文件')

    const restore = harness.tools.get('rewind_restore')
    const report = await restore.execute({ target: turn2.version }, { agent: { id: harness.session.id } })
    assert.equal(report.target.turn, 2)
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v1')
    assert.equal(exists(harness.workspace, 'new.txt'), true)
    assert.ok(report.safetyVersion > 0)

    const turn1 = (await tool.execute({}, { agent: { id: harness.session.id } })).points.find((point) => point.turn === 1)
    await restore.execute({ target: turn1.version }, { agent: { id: harness.session.id } })
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v0')
    assert.equal(exists(harness.workspace, 'new.txt'), false)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('HTTP API lists sessions/points and performs a rollback over POST', async () => {
  const harness = boot()
  try {
    harness.ctx.emit('session/created', harness.session)
    await waitFor(harness.manager)
    await seedTurn(harness, 1, { write: { 'a.txt': 'v1' } })

    const sessionsRoute = harness.routes.get('/dsh-all-rewind/api/sessions')
    const sessionsResponse = await callRoute(sessionsRoute, createMockRequest({
      headers: { host: '127.0.0.1:19387' },
    }))
    assert.equal(sessionsResponse.status, 200)
    const sessionsPayload = JSON.parse(sessionsResponse.body)
    assert.equal(sessionsPayload.sessions.length, 1)
    assert.equal(sessionsPayload.sessions[0].sessionId, harness.session.id)

    const pointsRoute = harness.routes.get('/dsh-all-rewind/api/points')
    const pointsResponse = await callRoute(pointsRoute, createMockRequest({
      url: `/dsh-all-rewind/api/points?sessionId=${harness.session.id}`,
      headers: { host: '127.0.0.1:19387' },
    }))
    assert.equal(pointsResponse.status, 200)
    const pointsPayload = JSON.parse(pointsResponse.body)
    assert.ok(pointsPayload.points.length >= 2)

    const turn1 = pointsPayload.points.find((point) => point.turn === 1)
    await seedTurn(harness, 2, { write: { 'a.txt': 'v2' } })

    const revertRoute = harness.routes.get('/dsh-all-rewind/api/revert')
    const revertResponse = await callRoute(revertRoute, createMockRequest({
      method: 'POST',
      url: '/dsh-all-rewind/api/revert',
      headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: harness.session.id, target: turn1.version }),
    }))
    assert.equal(revertResponse.status, 200, revertResponse.body)
    const revertPayload = JSON.parse(revertResponse.body)
    assert.equal(revertPayload.ok, true)
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v0')
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('HTTP surface rejects foreign hosts and cross-site requests', async () => {
  const harness = boot()
  try {
    const statusRoute = harness.routes.get('/dsh-all-rewind/api/status')
    const evil = await callRoute(statusRoute, createMockRequest({ headers: { host: 'evil.example.com' } }))
    assert.equal(evil.status, 403)
    assert.match(JSON.parse(evil.body).error, /untrusted Host/)

    const crossSite = await callRoute(statusRoute, createMockRequest({
      headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
    }))
    assert.equal(crossSite.status, 403)

    const originMismatch = await callRoute(statusRoute, createMockRequest({
      headers: { host: '127.0.0.1:19387', origin: 'https://evil.example.com' },
    }))
    assert.equal(originMismatch.status, 403)

    const local = await callRoute(statusRoute, createMockRequest({ headers: { host: '127.0.0.1:19387' } }))
    assert.equal(local.status, 200)
    assert.equal(JSON.parse(local.body).ok, true)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('UI asset route serves the panel script with a JS content type', async () => {
  const harness = boot()
  try {
    const route = harness.routes.get('/dsh-all-rewind/ui.js')
    const response = await callRoute(route, createMockRequest({ headers: { host: '127.0.0.1:19387' } }))
    assert.equal(response.status, 200)
    assert.match(response.headers['Content-Type'], /javascript/)
    assert.match(response.body, /__dshAllRewind/)
    assert.match(response.body, /var API = '\/dsh-all-rewind'/)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('plugin degrades gracefully when session snapshots fail (bad workspace)', async () => {
  const dataDir = makeTempDir('dsh-all-rewind-plugin-')
  const fake = createFakeContext()
  plugin.apply(fake.ctx, { ...DEFAULT_CONFIG, dataDir, log: true })
  const manager = managerOf(fake.ctx)
  try {
    const missingWorkspace = path.join(dataDir, 'does-not-exist')
    const session = { id: 'session-bad', header: { cwd: missingWorkspace } }
    fake.ctx.emit('session/created', session)
    fake.ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 }, seq: 1, time: Date.now() })
    await manager.drain()
    // A missing workspace is skipped with a log, not thrown into the event bus.
    assert.ok(fake.logs.length > 0)
    assert.equal(manager.listSessions().length, 0)
  } finally {
    cleanup(dataDir)
  }
})

test('plugin apply returns the manager and exposes config helpers', () => {
  const harness = boot()
  try {
    assert.ok(harness.manager)
    assert.equal(harness.manager.helpers.API_PREFIX, '/dsh-all-rewind')
    const resolved = resolveConfig({ keepTurns: 3 })
    assert.equal(resolved.keepTurns, 3)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('registerTools refuses unknown callers via the caller session default', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'v0' })
  const dataDir = makeTempDir('dsh-all-rewind-plugin-')
  const fake = createFakeContext()
  plugin.apply(fake.ctx, { ...DEFAULT_CONFIG, dataDir })
  const manager = managerOf(fake.ctx)
  try {
    const disposers = registerTools(fake.ctx, manager)
    assert.equal(disposers.length, TOOL_NAMES.length)
    const restore = fake.tools.get('rewind_restore')
    await assert.rejects(() => restore.execute({ target: 1 }, {}), /sessionId/)
    for (const dispose of disposers) dispose()
    assert.equal(fake.tools.size, 0)
  } finally {
    cleanup(workspace, dataDir)
  }
})
