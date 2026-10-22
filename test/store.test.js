import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  cleanup, exists, labels, makeStore, makeTempDir, makeWorkspace, readFile, removeFile, writeFiles,
} from './helpers.mjs'

test('hidden repository uses the TRAE v2 layout and commit naming', () => {
  const workspace = makeWorkspace({
    'src/app.js': 'console.log(1)\n',
    'README.md': '# demo\n',
  })
  const { store, dataDir } = makeStore(workspace)
  try {
    assert.ok(fs.existsSync(path.join(store.dir, 'first_graph.json')), 'first_graph.json exists')

    const baseline = store.capture({ type: 'baseline', label: 'baseline-1', force: true })
    assert.equal(baseline.type, 'baseline')
    assert.equal(baseline.stats.files, 2)
    assert.ok(baseline.commit)
    assert.ok(fs.existsSync(path.join(store.dir, 'base', 'content', 'src', 'app.js')), 'base/content mirrors the workspace')
    assert.ok(fs.existsSync(path.join(store.dir, 'latest_change.json')), 'latest_change.json exists')

    writeFiles(workspace, { 'src/app.js': 'console.log(2)\n', 'src/new.js': 'export {}\n' })
    removeFile(workspace, 'README.md')
    const turnPoint = store.capture({ type: 'before-chat-turn', turn: 1 })
    assert.equal(turnPoint.label, 'before-chat-turn-1')
    assert.deepEqual(turnPoint.changed.modified, ['src/app.js'])
    assert.deepEqual(turnPoint.changed.added, ['src/new.js'])
    assert.deepEqual(turnPoint.changed.deleted, ['README.md'])

    const subjects = labels(store)
    assert.ok(subjects.includes('baseline-1'), 'baseline commit')
    assert.ok(subjects.includes('before-chat-turn-1'), 'turn anchor commit')

    const blobs = Object.values(store.manifestOfVersion(turnPoint)).map((entry) => entry.sha256)
    assert.ok(blobs.every((blob) => /^[0-9a-f]{64}$/.test(blob)), 'manifest stores content-addressed blob ids')
    assert.ok(fs.existsSync(path.join(store.dir, 'disk', 'content', 'README.md')), 'deleted file kept under disk/content')
    assert.ok(!exists(workspace, 'README.md'))
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('each tool call snapshots only its own delta and no-op captures are skipped', () => {
  const workspace = makeWorkspace({ 'a.txt': 'a1' })
  const { store, dataDir } = makeStore(workspace)
  try {
    store.capture({ type: 'baseline', force: true })
    writeFiles(workspace, { 'a.txt': 'a2' })
    const call1 = store.capture({ type: 'toolcall', turn: 1, messageId: 'call_1' })
    assert.equal(call1.label, 'toolcall-1-call_1')
    assert.deepEqual(call1.changed.modified, ['a.txt'])

    const skip = store.capture({ type: 'toolcall', turn: 1, messageId: 'call_2' })
    assert.equal(skip.skipped, true)
    assert.equal(skip.reason, 'no-changes')

    writeFiles(workspace, { 'b.txt': 'b1' })
    const call3 = store.capture({ type: 'toolcall', turn: 1, messageId: 'call_3' })
    assert.deepEqual(call3.changed.added, ['b.txt'])
    assert.equal(call3.changed.modified.length, 0)
    assert.equal(call3.changed.deleted.length, 0)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('before-chat-turn is a per-turn anchor and duplicates are idempotent', () => {
  const workspace = makeWorkspace({ 'a.txt': 'v0' })
  const { store, dataDir } = makeStore(workspace)
  try {
    store.capture({ type: 'baseline', force: true })
    writeFiles(workspace, { 'a.txt': 'v1' })
    const first = store.capture({ type: 'before-chat-turn', turn: 1 })
    const duplicate = store.capture({ type: 'before-chat-turn', turn: 1 })
    assert.equal(duplicate.skipped, true)
    assert.equal(duplicate.reason, 'duplicate-turn')
    assert.equal(duplicate.version.version, first.version)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('restore rolls the workspace back to the state before the chosen turn', () => {
  const workspace = makeWorkspace({
    'src/app.js': 'base\n',
    'keep.txt': 'keep\n',
  })
  const { store, dataDir } = makeStore(workspace)
  try {
    store.capture({ type: 'baseline', force: true })

    // Turn 1: the "AI" rewrites app.js, creates new.txt and deletes keep.txt.
    store.capture({ type: 'before-chat-turn', turn: 1 })
    writeFiles(workspace, { 'src/app.js': 'turn1\n', 'new.txt': 'created by turn 1\n' })
    removeFile(workspace, 'keep.txt')
    store.capture({ type: 'toolcall', turn: 1, messageId: 'call_a' })

    // Turn 2: another rewrite on top of turn 1.
    const turn2 = store.capture({ type: 'before-chat-turn', turn: 2 })
    writeFiles(workspace, { 'src/app.js': 'turn2\n' })
    store.capture({ type: 'toolcall', turn: 2, messageId: 'call_b' })

    // Roll back to before turn 2: turn 1's result must be restored.
    const report2 = store.restore({ target: turn2.version })
    assert.deepEqual(report2.restored.sort(), ['src/app.js'])
    assert.equal(readFile(workspace, 'src/app.js'), 'turn1\n')
    assert.equal(readFile(workspace, 'new.txt'), 'created by turn 1\n')
    assert.equal(exists(workspace, 'keep.txt'), false)

    // Roll back to before turn 1: the original baseline must be restored.
    const points = store.listPoints()
    const turn1Point = points.find((point) => point.turn === 1)
    assert.ok(turn1Point, 'turn 1 point is listed')
    const report1 = store.restore({ target: turn1Point.version })
    assert.equal(readFile(workspace, 'src/app.js'), 'base\n')
    assert.equal(readFile(workspace, 'keep.txt'), 'keep\n')
    assert.equal(exists(workspace, 'new.txt'), false)
    assert.ok(report1.removed.includes('new.txt'))
    assert.ok(report1.safetyVersion > 0, 'a safety snapshot was recorded')
    assert.ok(report1.postVersion > report1.safetyVersion, 'a post-revert baseline was recorded')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('dry run reports the plan without touching the workspace', () => {
  const workspace = makeWorkspace({ 'a.txt': 'one' })
  const { store, dataDir } = makeStore(workspace)
  try {
    store.capture({ type: 'baseline', force: true })
    store.capture({ type: 'before-chat-turn', turn: 1 })
    writeFiles(workspace, { 'a.txt': 'two' })
    store.capture({ type: 'toolcall', turn: 1, messageId: 'call_1' })

    const report = store.restore({ target: store.listPoints()[0].version, dryRun: true })
    assert.equal(report.dryRun, true)
    assert.deepEqual(report.restored, ['a.txt'])
    assert.equal(readFile(workspace, 'a.txt'), 'two', 'file untouched by dry run')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('external edits after the snapshot are treated as conflicts', () => {
  const scenario = (onConflict) => {
    const workspace = makeWorkspace({ 'a.txt': 'one', 'b.txt': 'one' })
    const { store, dataDir } = makeStore(workspace)
    store.capture({ type: 'baseline', force: true })
    const target = store.capture({ type: 'before-chat-turn', turn: 1 })
    writeFiles(workspace, { 'a.txt': 'ai-edit', 'b.txt': 'ai-edit' })
    store.capture({ type: 'toolcall', turn: 1, messageId: 'call_1' })
    // The user edits a.txt outside the AI turn after the snapshot.
    writeFiles(workspace, { 'a.txt': 'user-hand-edit' })
    const report = store.restore({ target: target.version, onConflict })
    const values = { a: readFile(workspace, 'a.txt'), b: readFile(workspace, 'b.txt'), report, dataDir, workspace }
    cleanup(workspace, dataDir)
    return values
  }

  const overwrite = scenario('overwrite')
  assert.equal(overwrite.a, 'one', 'overwrite policy restores over the external edit')
  assert.equal(overwrite.b, 'one')
  assert.ok(overwrite.report.conflicts.some((conflict) => conflict.path === 'a.txt'))

  const skip = scenario('skip')
  assert.equal(skip.a, 'user-hand-edit', 'skip policy leaves the external edit alone')
  assert.equal(skip.b, 'one')
  assert.ok(skip.report.skipped.some((entry) => entry.path === 'a.txt'))
})

test('untracked files are never deleted by a rollback', () => {
  const workspace = makeWorkspace({ 'tracked.txt': 'v1' })
  const { store, dataDir } = makeStore(workspace)
  try {
    store.capture({ type: 'baseline', force: true })
    const target = store.capture({ type: 'before-chat-turn', turn: 1 })
    writeFiles(workspace, { 'tracked.txt': 'v2' })
    store.capture({ type: 'toolcall', turn: 1, messageId: 'call_1' })
    // Created after the last snapshot: no snapshot has ever seen it.
    writeFiles(workspace, { 'untracked-notes.md': 'mine' })
    const report = store.restore({ target: target.version })
    assert.equal(readFile(workspace, 'tracked.txt'), 'v1')
    assert.equal(readFile(workspace, 'untracked-notes.md'), 'mine')
    assert.ok(!report.removed.includes('untracked-notes.md'))
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('truncated scans block rollback instead of deleting unverified files', () => {
  const workspace = makeWorkspace({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' })
  const { store, dataDir } = makeStore(workspace, { maxFiles: 1 })
  try {
    store.capture({ type: 'baseline', force: true })
    const target = store.capture({ type: 'before-chat-turn', turn: 1 })
    assert.equal(target.truncated, true)
    assert.throws(() => store.restore({ target: target.version }), /truncated/i)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('prunePoints keeps the newest keepTurns rewind points', () => {
  const workspace = makeWorkspace({ 'a.txt': '0' })
  const { store, dataDir } = makeStore(workspace, { keepTurns: 3 })
  try {
    store.capture({ type: 'baseline', force: true })
    for (let turn = 1; turn <= 5; turn += 1) {
      writeFiles(workspace, { 'a.txt': String(turn) })
      store.capture({ type: 'before-chat-turn', turn })
    }
    assert.equal(store.listPoints().filter((point) => point.type === 'before-chat-turn').length, 5)
    const result = store.prunePoints({ keepTurns: 3 })
    assert.equal(result.dropped.length, 2)
    const points = store.listPoints().filter((point) => point.type === 'before-chat-turn')
    assert.deepEqual(points.map((point) => point.turn), [5, 4, 3])
    // New snapshots still work after pruning.
    writeFiles(workspace, { 'a.txt': '6' })
    const next = store.capture({ type: 'before-chat-turn', turn: 6 })
    assert.equal(next.label, 'before-chat-turn-6')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('maintenance compacts history and keeps the latest state restorable', () => {
  const workspace = makeWorkspace({ 'a.txt': '0' })
  const { store, dataDir } = makeStore(workspace)
  try {
    store.capture({ type: 'baseline', force: true })
    for (let turn = 1; turn <= 8; turn += 1) {
      store.capture({ type: 'before-chat-turn', turn })
      writeFiles(workspace, { 'a.txt': String(turn) })
      store.capture({ type: 'toolcall', turn, messageId: `call_${turn}` })
    }
    const before = store.status()
    const result = store.maintenance({ keepVersions: 4 })
    assert.ok(result.versions <= before.versions)
    assert.ok(result.droppedVersions.length > 0)
    assert.ok(result.removedObjects > 0, 'unreferenced objects were reclaimed')
    // The latest base mirror must still match the workspace after compaction.
    writeFiles(workspace, { 'a.txt': '9' })
    const point = store.capture({ type: 'before-chat-turn', turn: 9 })
    assert.deepEqual(point.changed.modified, ['a.txt'])
    const latestPoint = store.listPoints()[0]
    const report = store.restore({ target: latestPoint.version, dryRun: true })
    assert.equal(report.dryRun, true)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('updatePreview attaches the user message text to the current point', () => {
  const workspace = makeWorkspace({ 'a.txt': '1' })
  const { store, dataDir } = makeStore(workspace)
  try {
    store.capture({ type: 'baseline', force: true })
    store.capture({ type: 'before-chat-turn', turn: 1 })
    store.updatePreview({ turn: 1, preview: '把按钮改成蓝色' })
    const point = store.listPoints().find((entry) => entry.turn === 1)
    assert.equal(point.preview, '把按钮改成蓝色')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('ignore rules keep node_modules and .git out of snapshots', () => {
  const workspace = makeWorkspace({
    'src/index.js': 'x',
    'node_modules/pkg/index.js': 'huge dependency',
    '.git/config': 'not our repo',
    '.tmp/build.log': 'temporary',
    'dist/bundle.js': 'build output',
  })
  const { store, dataDir } = makeStore(workspace)
  try {
    const baseline = store.capture({ type: 'baseline', force: true })
    assert.deepEqual(Object.keys(store.manifestOfVersion(baseline)), ['src/index.js'])
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('tree manifests share unchanged directories and keep version metadata tiny', () => {
  const workspace = makeWorkspace({})
  const files = {}
  for (let index = 0; index < 200; index += 1) {
    files[`src/module_${index % 20}/file_${index}.js`] = `export const value_${index} = ${index}\n`
  }
  writeFiles(workspace, files)
  const { store, dataDir } = makeStore(workspace, { maxFiles: 100_000 })
  try {
    const baseline = store.capture({ type: 'baseline', force: true })
    const objectsAfterBaseline = store.objects.size().count

    // A marker commit with no file changes must reuse the same tree objects.
    store.capture({ type: 'before-chat-turn', turn: 0 })
    assert.equal(store.objects.size().count, objectsAfterBaseline, 'unchanged tree adds no new objects')

    for (let turn = 1; turn <= 12; turn += 1) {
      store.capture({ type: 'before-chat-turn', turn })
      writeFiles(workspace, {
        [`src/module_${turn % 20}/file_${turn}.js`]: `export const value_${turn} = "turn-${turn}"\n`,
        [`src/module_${(turn + 3) % 20}/file_${turn + 3}.js`]: `export const value_${turn + 3} = "turn-${turn}"\n`,
      })
      store.capture({ type: 'toolcall', turn, messageId: `call_${turn}` })
    }

    const versionBytes = fs.readdirSync(store.dir)
      .filter((name) => name.startsWith('version_file_'))
      .reduce((sum, name) => sum + fs.statSync(path.join(store.dir, name)).size, 0)
    // The old full-manifest design needed ~29 KiB/version for 400 files
    // (61 files ≈ 1.7 MiB); structural sharing should stay far below that.
    assert.ok(versionBytes < 120 * 1024, `version metadata should be small, got ${versionBytes} bytes`)
    const versions = store.loadVersions().length
    assert.ok(versionBytes / versions < 2048, 'less than 2 KiB of metadata per version')

    // Restore still works off the shared tree.
    const turn10 = store.listPoints().find((point) => point.turn === 10)
    const report = store.restore({ target: turn10.version })
    assert.ok(report.ok)
    assert.equal(readFile(workspace, 'src/module_10/file_10.js'), 'export const value_10 = "turn-7"\n')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('pruneVersions bounds total versions to the keepTurns window', () => {
  const workspace = makeWorkspace({ 'a.txt': '0' })
  const { store, dataDir } = makeStore(workspace, { keepTurns: 3 })
  try {
    store.capture({ type: 'baseline', force: true })
    let snapshotAfterFive = 0
    for (let turn = 1; turn <= 10; turn += 1) {
      store.capture({ type: 'before-chat-turn', turn })
      for (let call = 1; call <= 3; call += 1) {
        writeFiles(workspace, { 'a.txt': `${turn}-${call}` })
        store.capture({ type: 'toolcall', turn, messageId: `call_${turn}_${call}` })
      }
      store.pruneVersions({ keepTurns: 3 })
      if (turn === 5) snapshotAfterFive = store.loadVersions().length
    }
    const afterTen = store.loadVersions().length
    assert.equal(afterTen, snapshotAfterFive, 'version count stops growing once the window is full')
    assert.ok(afterTen <= 3 * 4 + 2, `expected a bounded version count, got ${afterTen}`)
    const points = store.listPoints().filter((point) => point.type === 'before-chat-turn')
    assert.deepEqual(points.map((point) => point.turn), [10, 9, 8])
    // Restoring to the oldest kept point still works after pruning.
    const oldest = points[points.length - 1]
    const report = store.restore({ target: oldest.version, dryRun: true })
    assert.equal(report.dryRun, true)
    assert.equal(report.target.turn, 8)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('legacy version files with an inline file map remain restorable', () => {
  const workspace = makeWorkspace({ 'a.txt': 'v0', 'src/b.txt': 'b0' })
  const { store, dataDir } = makeStore(workspace)
  try {
    store.capture({ type: 'baseline', force: true })
    const target = store.capture({ type: 'before-chat-turn', turn: 1 })
    const manifest = store.manifestOfVersion(target)
    // Simulate a snapshot written by the previous release (schemaVersion 1).
    const legacy = {
      schemaVersion: 1,
      version: target.version,
      commit: target.commit,
      type: target.type,
      label: target.label,
      turn: target.turn,
      time: target.time,
      files: Object.fromEntries(Object.entries(manifest).map(([repoPath, meta]) => [
        repoPath,
        { blob: meta.sha256, sha256: meta.sha256, size: 0 },
      ])),
    }
    fs.writeFileSync(path.join(store.dir, `version_file_${target.version}.json`), JSON.stringify(legacy))
    store.invalidateCache()

    writeFiles(workspace, { 'a.txt': 'v1', 'src/new.txt': 'new' })
    store.capture({ type: 'toolcall', turn: 1, messageId: 'call_1' })
    const report = store.restore({ target: target.version })
    assert.equal(readFile(workspace, 'a.txt'), 'v0')
    assert.equal(exists(workspace, 'src/new.txt'), false)
    assert.equal(readFile(workspace, 'src/b.txt'), 'b0')
  } finally {
    cleanup(workspace, dataDir)
  }
})
