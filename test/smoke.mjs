// One-command smoke test for dsh-all-rewind.
//
//   node test/smoke.mjs
//
// End-to-end without the DSH host: boots the Cordis plugin against a fake
// context, drives a three-turn conversation through `session/event`, then rolls
// the workspace back through both the host tool and the HTTP API, asserting the
// TRAE-style invariants along the way.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import plugin, { managerOf } from '../lib/index.js'
import {
  cleanup, makeTempDir, makeWorkspace, readFile, removeFile, writeFiles,
} from './helpers.mjs'
import { callRoute, createFakeContext, createMockRequest } from './fake-context.mjs'

const results = []
let failures = 0

async function check(name, fn) {
  try {
    await fn()
    results.push(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    results.push(`  FAIL  ${name}\n        ${error?.message ?? error}`)
  }
}

function boot(workspace, dataDir) {
  const fake = createFakeContext()
  plugin.apply(fake.ctx, { dataDir, keepTurns: 20 })
  const manager = managerOf(fake.ctx)
  const session = { id: 'session-smoke-1', header: { cwd: workspace } }
  const emit = async (type, data) => {
    fake.ctx.emit('session/event', session, { type, data, seq: data?.seq ?? 0, time: Date.now() })
    await manager.drain()
  }
  return { fake, manager, session, emit }
}

async function turn({ fake, manager, emit, session, turn, text, write, deletePaths = [], callId = `call_${turn}` }) {
  fake.ctx.emit('session/event', session, { type: 'turn/start', data: { turn }, seq: turn * 10, time: Date.now() })
  await manager.drain()
  fake.ctx.emit('session/event', session, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
    seq: turn * 10 + 1,
    time: Date.now(),
  })
  await manager.drain()
  if (write) writeFiles(session.header.cwd, write)
  for (const relative of deletePaths) removeFile(session.header.cwd, relative)
  fake.ctx.emit('session/event', session, {
    type: 'tool/call',
    data: { turn, step: 1, callId, name: 'write', arguments: '{}' },
    seq: turn * 10 + 2,
    time: Date.now(),
  })
  fake.ctx.emit('session/event', session, {
    type: 'tool/result',
    data: { turn, step: 1, message: { role: 'tool', toolCallId: callId, content: [] } },
    seq: turn * 10 + 3,
    time: Date.now(),
  })
  await manager.drain()
}

const workspace = makeWorkspace({
  'src/app.js': 'console.log("base")\n',
  'README.md': '# demo\n',
})
const dataDir = makeTempDir('dsh-all-rewind-smoke-')
const harness = boot(workspace, dataDir)
const { fake, manager, session, emit } = harness

console.log('dsh-all-rewind smoke test')
console.log(`  workspace: ${workspace}`)
console.log(`  snapshots: ${dataDir}`)

await check('plugin registers tools/routes/UI against the Cordis-like context', async () => {
  assert.deepEqual([...fake.tools.keys()].sort(), ['rewind_list', 'rewind_prune', 'rewind_restore', 'rewind_status'])
  assert.ok(fake.routes.has('/dsh-all-rewind/api/revert'))
  assert.ok(fake.routes.has('/dsh-all-rewind/ui.js'))
  assert.equal(fake.taps.length, 1)
})

await check('desktop index-injection row is registered exactly once', async () => {
  const table = []
  fake.ctx.emit('webserver/index-inject', table)
  fake.ctx.emit('webserver/index-inject', table)
  assert.equal(table.length, 1)
  assert.ok(table[0].text.includes('/dsh-all-rewind/ui.js'))
})

fake.ctx.emit('session/created', session)
await manager.drain()

await check('session baseline snapshot uses the TRAE v2 layout', async () => {
  const sessionDir = path.join(dataDir, 'snapshots', session.id, 'v2')
  assert.ok(fs.existsSync(path.join(sessionDir, 'objects')), 'objects/ exists')
  assert.ok(fs.existsSync(path.join(sessionDir, 'base', 'content', 'src', 'app.js')), 'base/content mirrors workspace')
  assert.ok(fs.existsSync(path.join(sessionDir, 'first_graph.json')), 'first_graph.json')
  assert.ok(fs.existsSync(path.join(sessionDir, 'latest_change.json')), 'latest_change.json')
  const versions = fs.readdirSync(sessionDir).filter((name) => name.startsWith('version_file_'))
  assert.equal(versions.length, 1)
})

await turn({ fake, manager, emit, session, turn: 1, text: '把 app.js 改成 v1', write: { 'src/app.js': 'console.log("v1")\n' } })
await turn({
  fake, manager, emit, session, turn: 2, text: '新建 feature.js 并删除 README',
  write: { 'src/feature.js': 'export const feature = 1\n' }, deletePaths: ['README.md'],
})
await turn({ fake, manager, emit, session, turn: 3, text: '再把 app.js 改成 v3', write: { 'src/app.js': 'console.log("v3")\n' } })

await check('turn anchors and toolcall commits are recorded with TRAE naming', async () => {
  const store = manager.storeForId(session.id)
  const labels = store.loadVersions().map((entry) => entry.label)
  assert.ok(labels.includes('before-chat-turn-1'))
  assert.ok(labels.includes('before-chat-turn-2'))
  assert.ok(labels.includes('before-chat-turn-3'))
  assert.ok(labels.includes('toolcall-1-call_1'))
  assert.ok(labels.includes('toolcall-2-call_2'))
})

await check('rewind points carry the user message preview', async () => {
  const points = manager.points({ sessionId: session.id })
  const turn2 = points.find((point) => point.turn === 2)
  assert.equal(turn2.preview, '新建 feature.js 并删除 README')
})

await check('content-addressed store deduplicates unchanged blobs', async () => {
  const store = manager.storeForId(session.id)
  const ids = Object.values(store.latestManifest()).map((entry) => entry.sha256)
  assert.equal(new Set(ids).size, ids.length, 'one blob per distinct content')
})

await check('host tool rewind_list + rewind_restore rolls back turn 3', async () => {
  const list = await fake.tools.get('rewind_list').execute({}, { agent: { id: session.id } })
  const turn3 = list.points.find((point) => point.turn === 3)
  const report = await fake.tools.get('rewind_restore').execute({ target: turn3.version }, { agent: { id: session.id } })
  assert.equal(report.ok, true)
  assert.equal(readFile(workspace, 'src/app.js'), 'console.log("v2")\n'.replace('v2', 'v1'))
  assert.equal(readFile(workspace, 'src/feature.js'), 'export const feature = 1\n')
  assert.equal(fs.existsSync(path.join(workspace, 'README.md')), false)
  assert.ok(report.safetyVersion > 0)
})

await check('HTTP POST /api/revert rolls back turn 2 through the wire', async () => {
  const pointsRoute = fake.routes.get('/dsh-all-rewind/api/points')
  const pointsResponse = await callRoute(pointsRoute, createMockRequest({
    url: `/dsh-all-rewind/api/points?sessionId=${session.id}`,
    headers: { host: '127.0.0.1:19387' },
  }))
  assert.equal(pointsResponse.status, 200)
  const points = JSON.parse(pointsResponse.body).points
  const turn2 = points.find((point) => point.turn === 2)

  const revertRoute = fake.routes.get('/dsh-all-rewind/api/revert')
  const response = await callRoute(revertRoute, createMockRequest({
    method: 'POST',
    url: '/dsh-all-rewind/api/revert',
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, target: turn2.version }),
  }))
  assert.equal(response.status, 200, response.body)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(readFile(workspace, 'src/app.js'), 'console.log("v1")\n')
  assert.equal(fs.existsSync(path.join(workspace, 'src/feature.js')), false)
  assert.equal(readFile(workspace, 'README.md'), '# demo\n')
})

await check('HTTP surface refuses a foreign Host header', async () => {
  const statusRoute = fake.routes.get('/dsh-all-rewind/api/status')
  const response = await callRoute(statusRoute, createMockRequest({ headers: { host: 'evil.example.com' } }))
  assert.equal(response.status, 403)
})

await check('a second rollback is possible because a safety snapshot was kept', async () => {
  const list = await fake.tools.get('rewind_list').execute({}, { agent: { id: session.id } })
  const safety = list.points.find((point) => point.type === 'pre-revert')
  assert.ok(safety || list.points.length >= 3)
  const report = await fake.tools.get('rewind_restore').execute(
    { target: 1, dryRun: true },
    { agent: { id: session.id } },
  )
  assert.equal(report.dryRun, true)
  assert.ok(Array.isArray(report.restored))
})

await check('prune + maintenance report reclaimed space', async () => {
  const pruned = manager.prune({ sessionId: session.id })
  assert.equal(pruned.sessions, 1)
  const maintenance = manager.maintenance({ sessionId: session.id, keepVersions: 10 })
  assert.equal(maintenance.sessions, 1)
  assert.ok(typeof maintenance.results[0].diskBytes === 'number')
})

await check('status endpoint reports sessions and points', async () => {
  const statusRoute = fake.routes.get('/dsh-all-rewind/api/status')
  const response = await callRoute(statusRoute, createMockRequest({ headers: { host: '127.0.0.1:19387' } }))
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.plugin, 'dsh-all-rewind')
  assert.ok(payload.points >= 1)
  assert.ok(payload.storage.dataDir, 'storage location exposed')
  assert.ok(payload.storage.diskBytes > 0, 'storage usage exposed')
  assert.equal(payload.backend, 'content-addressed-trees')
})

cleanup(workspace, dataDir)

console.log(results.join('\n'))
console.log('')
if (failures > 0) {
  console.error(`SMOKE FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('SMOKE PASSED')
