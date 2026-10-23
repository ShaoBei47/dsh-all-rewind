import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import plugin, { injectUiTag, managerOf, registerTools, TOOL_NAMES } from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'
import {
  cleanup,
  exists,
  fakeSession,
  gitSkipReason,
  makeTempDir,
  makeWorkspace,
  readFile,
  writeFiles,
} from './helpers.mjs'
import { callRoute, createFakeContext, createMockRequest } from './fake-context.mjs'

const skip = gitSkipReason()

function boot(options = {}) {
  const workspace = options.workspace ?? makeWorkspace({ 'a.txt': 'v0', 'src/app.js': 'base' })
  const dataDir = options.dataDir ?? makeTempDir('dsh-all-rewind-plugin-')
  const fake = createFakeContext(options.services ?? {})
  plugin.apply(fake.ctx, { keepTurns: 20, dataDir, ...(options.config ?? {}) })
  const manager = managerOf(fake.ctx)
  const sessionId = options.sessionId ?? 'session-plugin-1'
  const session = fakeSession(sessionId, workspace)
  return { ...fake, manager, workspace, dataDir, session, sessionId }
}

async function settle(harness) {
  await harness.manager.settle()
}

/** Emit one complete conversation turn, writing `write` files while it runs. */
async function seedTurn(harness, turn, { write = {}, seqBase = turn * 10 } = {}) {
  harness.ctx.emit('session/event', harness.session, {
    type: 'turn/start',
    seq: seqBase,
    time: Date.now(),
    data: { turn },
  })
  await settle(harness)
  harness.ctx.emit('session/event', harness.session, {
    type: 'user/message',
    seq: seqBase + 1,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text: `第 ${turn} 轮：改文件` }] },
  })
  await settle(harness)
  if (Object.keys(write).length > 0) writeFiles(harness.workspace, write)
  harness.ctx.emit('session/event', harness.session, {
    type: 'turn/end',
    seq: seqBase + 2,
    time: Date.now(),
    data: { turn, reason: { kind: 'completed' } },
  })
  await settle(harness)
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
    for (const routeName of ['status', 'sessions', 'points', 'rewind', 'prune', 'maintenance']) {
      assert.ok(harness.routes.has(`/dsh-all-rewind/api/${routeName}`), `route registered: ${routeName}`)
    }
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

test('full flow: shadow-git anchors from session events and a file rollback through the host tool', { skip }, async () => {
  const harness = boot()
  try {
    harness.ctx.emit('session/created', harness.session)
    await settle(harness)

    await seedTurn(harness, 1, { write: { 'a.txt': 'v1', 'new.txt': 'created' } })
    await seedTurn(harness, 2, { write: { 'a.txt': 'v2' } })
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v2')

    const listTool = harness.tools.get('rewind_list')
    const listed = await listTool.execute({}, { agent: { id: harness.sessionId } })
    assert.equal(listed.sessionId, harness.sessionId)
    const turn2 = listed.points.find((point) => point.turn === 2)
    assert.ok(turn2, 'turn 2 point listed')
    assert.equal(turn2.preview, '第 2 轮：改文件')
    assert.match(turn2.commit, /^[0-9a-f]{40}$/)

    // The shadow repository lives under dataDir/shadows, not inside the workspace.
    const shadows = fs.readdirSync(path.join(harness.dataDir, 'shadows'))
    assert.equal(shadows.length, 1)
    assert.ok(fs.existsSync(path.join(harness.dataDir, 'shadows', shadows[0], 'repo.git', 'HEAD')))
    assert.ok(fs.existsSync(path.join(harness.dataDir, 'shadows', shadows[0], 'state.json')))
    assert.equal(fs.existsSync(path.join(harness.workspace, '.git')), false)

    const restore = harness.tools.get('rewind_restore')
    const report = await restore.execute({ turn: 2 }, { agent: { id: harness.sessionId } })
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v1')
    assert.equal(exists(harness.workspace, 'new.txt'), true)
    assert.match(report.safetyCommit, /^[0-9a-f]{40}$/)

    const turn1 = (await listTool.execute({}, { agent: { id: harness.sessionId } })).points.find((point) => point.turn === 1)
    await restore.execute({ turn: turn1.turn }, { agent: { id: harness.sessionId } })
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v0')
    assert.equal(exists(harness.workspace, 'new.txt'), false)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('HTTP API lists sessions/points and rewinds files over POST', { skip }, async () => {
  const harness = boot()
  try {
    harness.ctx.emit('session/created', harness.session)
    await settle(harness)
    await seedTurn(harness, 1, { write: { 'a.txt': 'v1' } })
    await seedTurn(harness, 2, { write: { 'a.txt': 'v2' } })

    const sessionsResponse = await callRoute(harness.routes.get('/dsh-all-rewind/api/sessions'), createMockRequest({
      headers: { host: '127.0.0.1:19387' },
    }))
    assert.equal(sessionsResponse.status, 200)
    const sessionsPayload = JSON.parse(sessionsResponse.body)
    assert.equal(sessionsPayload.sessions.length, 1)
    assert.equal(sessionsPayload.sessions[0].sessionId, harness.sessionId)

    const pointsResponse = await callRoute(harness.routes.get('/dsh-all-rewind/api/points'), createMockRequest({
      url: `/dsh-all-rewind/api/points?sessionId=${harness.sessionId}`,
      headers: { host: '127.0.0.1:19387' },
    }))
    assert.equal(pointsResponse.status, 200)
    const pointsPayload = JSON.parse(pointsResponse.body)
    assert.deepEqual(pointsPayload.points.map((point) => point.turn), [2, 1])

    const rewindResponse = await callRoute(harness.routes.get('/dsh-all-rewind/api/rewind'), createMockRequest({
      method: 'POST',
      url: '/dsh-all-rewind/api/rewind',
      headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: harness.sessionId, turn: 2, mode: 'files' }),
    }))
    assert.equal(rewindResponse.status, 200, rewindResponse.body)
    const payload = JSON.parse(rewindResponse.body)
    assert.equal(payload.ok, true)
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v1')

    const statusResponse = await callRoute(harness.routes.get('/dsh-all-rewind/api/status'), createMockRequest({
      headers: { host: '127.0.0.1:19387' },
    }))
    const status = JSON.parse(statusResponse.body)
    assert.equal(status.plugin, 'dsh-all-rewind')
    assert.equal(status.backend, 'shadow-git')
    assert.equal(status.git.available, true)
    assert.ok(status.storage.dataDir)
    assert.ok(status.storage.diskBytes > 0)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('conversation rewind through the wire registers a deferred in-place cut', { skip }, async () => {
  const harness = boot()
  try {
    harness.ctx.emit('session/created', harness.session)
    await settle(harness)
    await seedTurn(harness, 1, { write: { 'a.txt': 'v1' } })
    await seedTurn(harness, 2, { write: { 'a.txt': 'v2' } })

    const response = await callRoute(harness.routes.get('/dsh-all-rewind/api/rewind'), createMockRequest({
      method: 'POST',
      url: '/dsh-all-rewind/api/rewind',
      headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: harness.sessionId, turn: 2 }),
    }))
    assert.equal(response.status, 200, response.body)
    const payload = JSON.parse(response.body)
    assert.equal(payload.conversation.deferred, true)
    assert.equal(payload.conversation.mode, 'surface-replace')
    assert.equal(payload.conversation.cutAtSeq, 20)
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v1')

    const pointsResponse = await callRoute(harness.routes.get('/dsh-all-rewind/api/points'), createMockRequest({
      url: `/dsh-all-rewind/api/points?sessionId=${harness.sessionId}`,
      headers: { host: '127.0.0.1:19387' },
    }))
    const pointsPayload = JSON.parse(pointsResponse.body)
    assert.equal(pointsPayload.pendingCut.turn, 2)
    assert.deepEqual(pointsPayload.points.map((point) => point.turn), [1])
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('the agent/request waterfall appends the empty system surface replace', { skip }, async () => {
  const harness = boot()
  try {
    harness.ctx.emit('session/created', harness.session)
    await settle(harness)
    await seedTurn(harness, 1, { write: { 'a.txt': 'v1' } })
    await seedTurn(harness, 2, { write: { 'a.txt': 'v2' } })
    await harness.manager.rewind({ sessionId: harness.sessionId, turn: 2 })
    await settle(harness)

    const live = { id: harness.sessionId, surface: { nodes: [0, 1, 9, 20, 21] }, appended: [], append(type, data, opts) { this.appended.push({ type, data, opts }) } }
    harness.ctx.emit('agent/request', { agent: { session: live }, turn: 2, step: 1 }, () => {})
    assert.equal(live.appended.length, 1)
    assert.equal(live.appended[0].type, 'system/message')
    assert.deepEqual(live.appended[0].opts.surfaceOp, { op: 'replace', startSeq: 20, endSeq: 21 })
    assert.deepEqual(live.appended[0].opts.sourceEventSeqs, [20, 21])
    assert.deepEqual(live.appended[0].data.message.content, [])
    assert.equal(harness.manager.pendingCut(harness.sessionId), null)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('conversation rewind is refused explicitly when the feature is disabled', { skip }, async () => {
  const harness = boot({ config: { conversation: { enabled: false } } })
  try {
    harness.ctx.emit('session/created', harness.session)
    await settle(harness)
    await seedTurn(harness, 1, { write: { 'a.txt': 'v1' } })
    await seedTurn(harness, 2, { write: { 'a.txt': 'v2' } })

    const response = await callRoute(harness.routes.get('/dsh-all-rewind/api/rewind'), createMockRequest({
      method: 'POST',
      url: '/dsh-all-rewind/api/rewind',
      headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: harness.sessionId, turn: 2 }),
    }))
    assert.equal(response.status, 500)
    assert.equal(JSON.parse(response.body).code, 'CONVERSATION_DISABLED')
    assert.equal(readFile(harness.workspace, 'a.txt'), 'v2')
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
    const response = await callRoute(harness.routes.get('/dsh-all-rewind/ui.js'), createMockRequest({
      headers: { host: '127.0.0.1:19387' },
    }))
    assert.equal(response.status, 200)
    assert.match(response.headers['Content-Type'], /javascript/)
    assert.match(response.body, /__dshAllRewind/)
    assert.match(response.body, /var API = '\/dsh-all-rewind'/)
    assert.match(response.body, /dsh-all-rewind:cut:/)
    assert.match(response.body, /collapseFromNode/)
    assert.match(response.body, /backfillComposer/)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('plugin degrades gracefully when a workspace does not exist', { skip }, async () => {
  const harness = boot()
  try {
    const missingWorkspace = path.join(harness.dataDir, 'does-not-exist')
    const session = fakeSession('session-bad', missingWorkspace)
    harness.ctx.emit('session/created', session)
    await harness.manager.settle()
    // A missing workspace is skipped with a log, not thrown into the event bus.
    assert.ok(harness.logs.length > 0)
    assert.equal(harness.manager.sessions().length, 0)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('plugin apply exposes the manager and its helpers', () => {
  const harness = boot()
  try {
    assert.ok(harness.manager)
    assert.equal(harness.manager.helpers.API_PREFIX, '/dsh-all-rewind')
    const resolved = resolveConfig({ keepTurns: 3 })
    assert.equal(resolved.keepTurns, 3)
    assert.equal(resolved.conversation.enabled, true)
  } finally {
    cleanup(harness.workspace, harness.dataDir)
  }
})

test('registerTools refuses unknown callers via the caller session default', async () => {
  const workspace = makeWorkspace({ 'a.txt': 'v0' })
  const dataDir = makeTempDir('dsh-all-rewind-plugin-')
  const fake = createFakeContext()
  plugin.apply(fake.ctx, { dataDir })
  const manager = managerOf(fake.ctx)
  try {
    const disposers = registerTools(fake.ctx, manager)
    assert.equal(disposers.length, TOOL_NAMES.length)
    const restore = fake.tools.get('rewind_restore')
    await assert.rejects(() => restore.execute({ turn: 1 }, {}), /sessionId/)
    for (const dispose of disposers) dispose()
    assert.equal(fake.tools.size, 0)
  } finally {
    cleanup(workspace, dataDir)
  }
})
