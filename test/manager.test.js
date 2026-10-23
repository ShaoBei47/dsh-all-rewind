// Manager tests: turn anchors from session events, in-place conversation cuts
// (deferred surface replace), safety snapshots and refusals. Real git, fake DSH
// services and a fake live Session with a surface.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { RewindManager } from '../lib/manager.js'
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

const skip = gitSkipReason()

function harness(options = {}) {
  const workspace = options.workspace ?? makeWorkspace({
    'a.txt': 'v0',
    'src/app.js': 'base',
    '.gitignore': 'ignored/\n',
    'ignored/keep.bin': 'never snapshotted',
  })
  const dataDir = options.dataDir ?? makeTempDir('dsh-all-rewind-manager-')
  const sessionId = options.sessionId ?? 'session-test-1'
  const session = fakeSession(sessionId, workspace)
  const logs = []
  const live = new Map()
  function liveSession(id) {
    if (!live.has(id)) {
      live.set(id, {
        id,
        surface: { nodes: [] },
        appended: [],
        append(type, data, opts) {
          this.appended.push({ type, data, opts })
          return { type, seq: 1000 + this.appended.length, data }
        },
      })
    }
    return live.get(id)
  }
  const services = {
    sessions: {
      get: (id) => liveSession(id),
      flush: () => {},
    },
    sandboxPolicy: {
      resolve() {
        return { mode: options.sandboxMode ?? 'workspace-write' }
      },
    },
  }
  const config = resolveConfig({
    dataDir,
    keepTurns: 20,
    autoMaintenance: { enabled: false },
    ...(options.config ?? {}),
  })
  const manager = new RewindManager({ config, log: (message, level) => logs.push({ message, level }), services })
  return { manager, workspace, dataDir, config, session, sessionId, logs, services, liveSession }
}

async function startTurn(h, turn, seq) {
  h.manager.onSessionEvent(h.session, { type: 'turn/start', seq, time: Date.now(), data: { turn } })
  await h.manager.settle()
}

async function finishTurn(h, turn, seq) {
  h.manager.onSessionEvent(h.session, { type: 'turn/end', seq, time: Date.now(), data: { turn, reason: { kind: 'completed' } } })
  await h.manager.settle()
}

async function prompt(h, turn, seq, text = `第 ${turn} 轮提示词`) {
  h.manager.onSessionEvent(h.session, {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text }] },
  })
  await h.manager.settle()
}

/**
 * Three completed turns (turn/start seqs 0, 3, 6):
 *   before turn 1: a.txt=v0
 *   turn 1 AI:     a.txt=v1 + created.txt
 *   turn 2 AI:     a.txt=v2 + note.txt
 *   turn 3 AI:     a.txt=v3
 */
async function seedThreeTurns(h) {
  await startTurn(h, 1, 0)
  await prompt(h, 1, 1, 'first prompt')
  writeFiles(h.workspace, { 'a.txt': 'v1', 'created.txt': 'turn 1' })
  await finishTurn(h, 1, 2)

  await startTurn(h, 2, 3)
  await prompt(h, 2, 4, 'second prompt')
  writeFiles(h.workspace, { 'a.txt': 'v2', 'note.txt': 'turn 2' })
  await finishTurn(h, 2, 5)

  await startTurn(h, 3, 6)
  await prompt(h, 3, 7, 'third prompt')
  writeFiles(h.workspace, { 'a.txt': 'v3' })
  await finishTurn(h, 3, 8)
}

test('turn events create one anchor per turn with previews, prompts and sequence numbers', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    const points = await h.manager.points(h.sessionId)
    assert.deepEqual(points.map((point) => point.turn), [3, 2, 1])
    const turn2 = points.find((point) => point.turn === 2)
    assert.equal(turn2.seq, 3)
    assert.equal(turn2.seqBefore, 2)
    assert.equal(turn2.preview, 'second prompt')
    assert.equal(turn2.prompt, 'second prompt')
    assert.match(turn2.commit, /^[0-9a-f]{40}$/)
    const status = await h.manager.status()
    assert.equal(status.backend, 'shadow-git')
    assert.equal(status.git.available, true)
    assert.equal(status.points, 3)
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('rewind "all" restores files and registers a deferred in-place conversation cut', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    const result = await h.manager.rewind({ sessionId: h.sessionId, turn: 2 })
    await h.manager.settle()

    // Files: state before turn 2 = turn 1's result.
    assert.equal(readFile(h.workspace, 'a.txt'), 'v1')
    assert.ok(exists(h.workspace, 'created.txt'))
    assert.equal(exists(h.workspace, 'note.txt'), false)
    assert.ok(result.files.restored.includes('a.txt'))
    assert.ok(result.files.removed.includes('note.txt'))

    // Conversation: an in-place cut stays pending until the next model request.
    assert.equal(result.conversation.deferred, true)
    assert.equal(result.conversation.mode, 'surface-replace')
    assert.equal(result.conversation.cutAtSeq, 3)
    assert.equal(h.liveSession(h.sessionId).appended.length, 0, 'nothing appended outside an open turn')

    // Anchors at/after the cut are no longer reachable conversation points.
    assert.deepEqual((await h.manager.points(h.sessionId)).map((point) => point.turn), [1])
    assert.deepEqual(h.manager.pendingCut(h.sessionId), { turn: 2, cutAtSeq: 3, createdAt: h.manager.pendingCut(h.sessionId).createdAt })
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('the pending cut is appended as an empty system surface replace on the next request', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    await h.manager.rewind({ sessionId: h.sessionId, turn: 2 })
    const live = h.liveSession(h.sessionId)
    live.surface.nodes = [0, 1, 2, 3, 4, 5]
    h.manager.applyPendingConversationCut({ agent: { session: live }, turn: 2, step: 1 })
    assert.equal(live.appended.length, 1)
    const appended = live.appended[0]
    assert.equal(appended.type, 'system/message')
    assert.equal(appended.data.turn, 2)
    assert.equal(appended.data.step, 1)
    assert.equal(appended.data.message.role, 'system')
    assert.deepEqual(appended.data.message.content, [])
    assert.equal(appended.data.message.source.kind, 'system-prompt')
    assert.deepEqual(appended.opts.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 5 })
    assert.deepEqual(appended.opts.sourceEventSeqs, [3, 4, 5])
    // Applied once: no pending cut remains and a second request appends nothing.
    assert.equal(h.manager.pendingCut(h.sessionId), null)
    h.manager.applyPendingConversationCut({ agent: { session: live }, turn: 3, step: 1 })
    assert.equal(live.appended.length, 1)
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('the surface head node is replaced with itself instead of being shadowed', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    await h.manager.rewind({ sessionId: h.sessionId, turn: 1 })
    const live = h.liveSession(h.sessionId)
    live.surface.nodes = [0, 1, 2, 3]
    h.manager.applyPendingConversationCut({ agent: { session: live }, turn: 1, step: 1 })
    assert.equal(live.appended.length, 2)
    assert.deepEqual(live.appended[0].opts.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 })
    assert.deepEqual(live.appended[0].opts.sourceEventSeqs, [0])
    assert.deepEqual(live.appended[1].opts.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 3 })
    assert.deepEqual(live.appended[1].opts.sourceEventSeqs, [1, 2, 3])
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('a pending cut survives a manager restart and still applies', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    await h.manager.rewind({ sessionId: h.sessionId, turn: 2 })
    const restarted = new RewindManager({
      config: h.config,
      services: { sessions: { get: () => h.liveSession(h.sessionId), flush: () => {} } },
    })
    const live = h.liveSession(h.sessionId)
    live.surface.nodes = [0, 1, 2, 3]
    restarted.applyPendingConversationCut({ agent: { session: live }, turn: 2, step: 1 })
    assert.equal(live.appended.length, 1)
    assert.deepEqual(live.appended[0].opts.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('applyPendingConversationCut ignores requests without a pending cut or open step', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    const live = h.liveSession(h.sessionId)
    live.surface.nodes = [0, 1, 2, 3]
    // no pending cut
    h.manager.applyPendingConversationCut({ agent: { session: live }, turn: 2, step: 1 })
    assert.equal(live.appended.length, 0)
    await h.manager.rewind({ sessionId: h.sessionId, turn: 2, mode: 'files' })
    h.manager.applyPendingConversationCut({ agent: { session: live }, turn: 2, step: 1 })
    assert.equal(live.appended.length, 0)
    // pending cut but the payload lacks a valid step
    await h.manager.rewind({ sessionId: h.sessionId, turn: 2, mode: 'chat' })
    h.manager.applyPendingConversationCut({ agent: { session: live } })
    assert.equal(live.appended.length, 0)
    assert.ok(h.manager.pendingCut(h.sessionId), 'invalid payload keeps the cut pending for a real request')
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('rewind "files" leaves the conversation alone', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    const result = await h.manager.rewind({ sessionId: h.sessionId, turn: 3, mode: 'files' })
    assert.equal(readFile(h.workspace, 'a.txt'), 'v2')
    assert.equal(result.conversation, null)
    assert.equal(h.manager.pendingCut(h.sessionId), null)
    assert.deepEqual((await h.manager.points(h.sessionId)).map((point) => point.turn), [3, 2, 1])
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('rewind "chat" cuts the conversation without touching files', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    const result = await h.manager.rewind({ sessionId: h.sessionId, turn: 2, mode: 'chat' })
    assert.equal(readFile(h.workspace, 'a.txt'), 'v3')
    assert.equal(result.files, null)
    assert.equal(result.conversation.deferred, true)
    assert.equal(h.manager.pendingCut(h.sessionId).turn, 2)
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('a dry run reports the file plan and the cut without changing anything', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    const result = await h.manager.rewind({ sessionId: h.sessionId, turn: 2, dryRun: true })
    assert.equal(readFile(h.workspace, 'a.txt'), 'v3')
    assert.equal(exists(h.workspace, 'note.txt'), true)
    assert.ok(result.files.restored.includes('a.txt'))
    assert.ok(result.files.removed.includes('note.txt'))
    assert.equal(result.conversation.cutAtSeq, 3)
    assert.equal(h.manager.pendingCut(h.sessionId), null)
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('refuses to rewind while the session is running', { skip }, async () => {
  const h = harness()
  try {
    await startTurn(h, 1, 0)
    await prompt(h, 1, 1)
    writeFiles(h.workspace, { 'a.txt': 'v1' })
    await assert.rejects(
      () => h.manager.rewind({ sessionId: h.sessionId, turn: 1 }),
      (error) => error.code === 'SESSION_RUNNING',
    )
    assert.equal(readFile(h.workspace, 'a.txt'), 'v1')
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('read-only sessions refuse a file rewind unless forced', { skip }, async () => {
  const h = harness({ sandboxMode: 'read-only' })
  try {
    await seedThreeTurns(h)
    await assert.rejects(
      () => h.manager.rewind({ sessionId: h.sessionId, turn: 2, mode: 'files' }),
      (error) => error.code === 'READ_ONLY_SESSION',
    )
    assert.equal(readFile(h.workspace, 'a.txt'), 'v3')
    const forced = await h.manager.rewind({ sessionId: h.sessionId, turn: 2, mode: 'files', force: true })
    assert.ok(forced.files)
    assert.equal(readFile(h.workspace, 'a.txt'), 'v1')
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('unknown sessions/turns and disabled conversation produce clear errors', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    await assert.rejects(
      () => h.manager.rewind({ sessionId: h.sessionId, turn: 99 }),
      (error) => error.code === 'NO_POINT',
    )
    await assert.rejects(
      () => h.manager.rewind({ sessionId: 'session-unknown', turn: 1 }),
      (error) => error.code === 'NO_POINT',
    )
    await assert.rejects(
      () => h.manager.rewind({ sessionId: h.sessionId, turn: 0 }),
      (error) => error.code === 'BAD_REQUEST',
    )
    h.manager.config.conversation.enabled = false
    await assert.rejects(
      () => h.manager.rewind({ sessionId: h.sessionId, turn: 2 }),
      (error) => error.code === 'CONVERSATION_DISABLED',
    )
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('the safety snapshot can undo a rewind', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    const result = await h.manager.rewind({ sessionId: h.sessionId, turn: 2, mode: 'files' })
    assert.equal(readFile(h.workspace, 'a.txt'), 'v1')
    assert.match(result.files.safetyCommit, /^[0-9a-f]{40}$/)
    const undone = await h.manager.restoreFiles({ sessionId: h.sessionId, commit: result.files.safetyCommit })
    assert.match(undone.safetyCommit, /^[0-9a-f]{40}$/)
    assert.equal(readFile(h.workspace, 'a.txt'), 'v3')
    assert.ok(exists(h.workspace, 'note.txt'))
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('rewind keeps ignored files', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    writeFiles(h.workspace, { 'ignored/user.bin': 'user data' })
    await h.manager.rewind({ sessionId: h.sessionId, turn: 2, mode: 'files' })
    assert.equal(readFile(h.workspace, 'ignored/user.bin'), 'user data')
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('keepTurns prunes old anchors but keeps the newest window', { skip }, async () => {
  const h = harness({ config: { keepTurns: 2 } })
  try {
    await seedThreeTurns(h)
    const points = await h.manager.points(h.sessionId)
    assert.deepEqual(points.map((point) => point.turn), [3, 2])
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('maintenance packs the shadow repository', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    const result = await h.manager.maintenance()
    assert.equal(result.workspaces, 1)
    assert.ok(result.results[0].bytesAfter >= 0)
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('diagnostics record the deferred cut', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    await h.manager.rewind({ sessionId: h.sessionId, turn: 2 })
    h.manager.applyPendingConversationCut({
      agent: { session: h.liveSession(h.sessionId) },
      turn: 2,
      step: 1,
    })
    const diag = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'diagnostics.json'), 'utf8'))
    assert.ok(diag.events.some((event) => event.name === 'cut-pending'))
    assert.ok(diag.events.some((event) => event.name === 'cut-applied'))
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})

test('two sessions in one workspace share the same shadow repository', { skip }, async () => {
  const h = harness()
  try {
    await seedThreeTurns(h)
    const other = fakeSession('session-test-2', h.workspace)
    h.manager.onSessionEvent(other, { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } })
    await h.manager.settle()
    h.manager.onSessionEvent(other, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
    await h.manager.settle()
    const sessions = h.manager.sessions()
    assert.equal(sessions.length, 2)
    assert.equal(new Set(sessions.map((entry) => entry.workspace)).size, 1)
    const dirs = fs.readdirSync(path.join(h.dataDir, 'shadows'))
    assert.equal(dirs.length, 1, 'one shadow workspace directory for both sessions')
  } finally {
    cleanup(h.workspace, h.dataDir)
  }
})
