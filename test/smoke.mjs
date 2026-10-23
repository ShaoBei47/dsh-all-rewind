// One-command smoke test for dsh-all-rewind (shadow-git backend).
//
//   node test/smoke.mjs
//
// End-to-end without the DSH host: boots the Cordis plugin against a fake
// context, drives a three-turn conversation through `session/event` (real git
// snapshots), then rewinds files through the host tool and the HTTP API. The
// conversation half is exercised with a fake live Session: the deferred cut is
// appended as an empty `system/message` surface replace on the next request.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import plugin, { managerOf } from '../lib/index.js'
import {
  cleanup, fakeSession, makeTempDir, makeWorkspace, readFile, removeFile, writeFiles,
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

const workspace = makeWorkspace({
  'src/app.js': 'console.log("base")\n',
  'README.md': '# demo\n',
})
const dataDir = makeTempDir('dsh-all-rewind-smoke-')
let manager
const live = {
  id: 'session-smoke-1',
  surface: { nodes: [] },
  appended: [],
  append(type, data, opts) {
    this.appended.push({ type, data, opts })
  },
}
const services = {
  sessions: {
    get: () => live,
    flush: () => {},
  },
}
const fake = createFakeContext(services)
plugin.apply(fake.ctx, { dataDir, keepTurns: 20 })
manager = managerOf(fake.ctx)
const session = fakeSession('session-smoke-1', workspace)

async function emit(type, data, seq) {
  fake.ctx.emit('session/event', session, { type, data, seq, time: Date.now() })
  await manager.settle()
}

async function turn({ turn, text, write, deletePaths = [], seqBase }) {
  await emit('turn/start', { turn }, seqBase)
  await emit('user/message', { role: 'user', content: [{ type: 'text', text }] }, seqBase + 1)
  if (write) writeFiles(workspace, write)
  for (const relative of deletePaths) removeFile(workspace, relative)
  await emit('turn/end', { turn, reason: { kind: 'completed' } }, seqBase + 2)
}

console.log('dsh-all-rewind smoke test (shadow-git)')
console.log(`  workspace: ${workspace}`)
console.log(`  storage:   ${dataDir}`)

await check('plugin registers tools/routes/UI against the Cordis-like context', async () => {
  assert.deepEqual([...fake.tools.keys()].sort(), ['rewind_list', 'rewind_prune', 'rewind_restore', 'rewind_status'])
  assert.ok(fake.routes.has('/dsh-all-rewind/api/rewind'))
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
await manager.settle()

await turn({ turn: 1, text: '把 app.js 改成 v1', write: { 'src/app.js': 'console.log("v1")\n' }, seqBase: 10 })
await turn({
  turn: 2,
  text: '新建 feature.js 并删除 README',
  write: { 'src/feature.js': 'export const feature = 1\n' },
  deletePaths: ['README.md'],
  seqBase: 20,
})
await turn({ turn: 3, text: '再把 app.js 改成 v3', write: { 'src/app.js': 'console.log("v3")\n' }, seqBase: 30 })

await check('the shadow repository lives outside the workspace', async () => {
  const shadows = fs.readdirSync(path.join(dataDir, 'shadows'))
  assert.equal(shadows.length, 1)
  const repoDir = path.join(dataDir, 'shadows', shadows[0], 'repo.git')
  assert.ok(fs.existsSync(path.join(repoDir, 'HEAD')), 'git dir created')
  assert.ok(fs.existsSync(path.join(dataDir, 'shadows', shadows[0], 'state.json')), 'anchor state written')
  assert.equal(fs.existsSync(path.join(workspace, '.git')), false, 'the workspace is not turned into a repo')
})

await check('one turn anchor per turn with the user prompt preview', async () => {
  const points = await manager.points(session.id)
  assert.deepEqual(points.map((point) => point.turn), [3, 2, 1])
  assert.equal(points.find((point) => point.turn === 2).preview, '新建 feature.js 并删除 README')
  for (const point of points) assert.match(point.commit, /^[0-9a-f]{40}$/)
})

await check('status reports the shadow-git backend, git and storage', async () => {
  const status = await manager.status()
  assert.equal(status.plugin, 'dsh-all-rewind')
  assert.equal(status.backend, 'shadow-git')
  assert.equal(status.git.available, true)
  assert.equal(status.points, 3)
  assert.ok(status.storage.diskBytes > 0)
  assert.ok(status.storage.dataDir)
})

await check('host tool rewind_list + rewind_restore rolls back turn 3 files', async () => {
  const list = await fake.tools.get('rewind_list').execute({}, { agent: { id: session.id } })
  const turn3 = list.points.find((point) => point.turn === 3)
  const report = await fake.tools.get('rewind_restore').execute({ turn: turn3.turn }, { agent: { id: session.id } })
  assert.match(report.safetyCommit, /^[0-9a-f]{40}$/)
  assert.equal(readFile(workspace, 'src/app.js'), 'console.log("v1")\n')
  assert.equal(readFile(workspace, 'src/feature.js'), 'export const feature = 1\n')
  assert.equal(fs.existsSync(path.join(workspace, 'README.md')), false)
})

await check('HTTP POST /api/rewind registers a deferred in-place conversation cut', async () => {
  const response = await callRoute(fake.routes.get('/dsh-all-rewind/api/rewind'), createMockRequest({
    method: 'POST',
    url: '/dsh-all-rewind/api/rewind',
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, turn: 2 }),
  }))
  assert.equal(response.status, 200, response.body)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.conversation.deferred, true)
  assert.equal(payload.conversation.mode, 'surface-replace')
  assert.equal(readFile(workspace, 'src/app.js'), 'console.log("v1")\n')
  assert.equal(fs.existsSync(path.join(workspace, 'src/feature.js')), false)
  assert.equal(readFile(workspace, 'README.md'), '# demo\n')
  assert.equal(manager.pendingCut(session.id).turn, 2)
  assert.deepEqual((await manager.points(session.id)).map((point) => point.turn), [1])
})

await check('the agent/request waterfall appends the empty system surface replace', async () => {
  live.surface.nodes = [0, 1, 9, 30, 31]
  fake.ctx.emit('agent/request', { agent: { session: live }, turn: 2, step: 1 }, () => {})
  assert.equal(live.appended.length, 1)
  assert.equal(live.appended[0].type, 'system/message')
  assert.deepEqual(live.appended[0].data.message.content, [])
  assert.deepEqual(live.appended[0].opts.surfaceOp, { op: 'replace', startSeq: 30, endSeq: 31 })
  assert.equal(manager.pendingCut(session.id), null)
})

await check('the archived safety snapshot can still undo a files-only rewind', async () => {
  const report = await fake.tools.get('rewind_restore').execute({ turn: 1 }, { agent: { id: session.id } })
  assert.equal(readFile(workspace, 'src/app.js'), 'console.log("base")\n')
  assert.match(report.safetyCommit, /^[0-9a-f]{40}$/)
  const undone = await fake.tools.get('rewind_restore').execute({ commit: report.safetyCommit }, { agent: { id: session.id } })
  assert.match(undone.safetyCommit, /^[0-9a-f]{40}$/)
  assert.equal(readFile(workspace, 'src/app.js'), 'console.log("v1")\n')
})

await check('HTTP surface refuses a foreign Host header', async () => {
  const response = await callRoute(fake.routes.get('/dsh-all-rewind/api/status'), createMockRequest({
    headers: { host: 'evil.example.com' },
  }))
  assert.equal(response.status, 403)
})

await check('prune + maintenance report reclaimed space', async () => {
  const pruned = await manager.prune({ sessionId: session.id })
  assert.equal(typeof pruned.dropped, 'number')
  const maintenance = await manager.maintenance({ sessionId: session.id })
  assert.equal(maintenance.workspaces, 1)
  assert.ok(typeof maintenance.results[0].bytesAfter === 'number')
})

await check('status endpoint reports sessions and points', async () => {
  const response = await callRoute(fake.routes.get('/dsh-all-rewind/api/status'), createMockRequest({
    headers: { host: '127.0.0.1:19387' },
  }))
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.plugin, 'dsh-all-rewind')
  assert.equal(payload.backend, 'shadow-git')
  assert.ok(payload.storage.dataDir, 'storage location exposed')
  assert.ok(payload.storage.diskBytes > 0, 'storage usage exposed')
})

cleanup(workspace, dataDir)

console.log(results.join('\n'))
console.log('')
if (failures > 0) {
  console.error(`SMOKE FAILED: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('SMOKE PASSED')
