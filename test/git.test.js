// Shadow-git engine tests: repository init, per-turn commits, restore semantics,
// ignore handling, packing and workspace keys. These tests run real git.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  GitRunner,
  ShadowRepository,
  buildExcludeText,
  detectGit,
  workspaceKey,
} from '../lib/git.js'
import { resolveConfig } from '../lib/config.js'
import {
  cleanup,
  exists,
  gitAvailable,
  gitSkipReason,
  makeTempDir,
  makeWorkspace,
  readFile,
  writeFiles,
} from './helpers.mjs'

const skip = gitSkipReason()

function makeGit() {
  return detectGit('git')
}

function configFor(dataDir) {
  return resolveConfig({ dataDir, autoMaintenance: { enabled: false } })
}

async function makeRepo(workspace, dataDir) {
  const config = configFor(dataDir)
  const info = await detectGit(config.gitExecutable)
  const git = new GitRunner({
    executable: info.executable,
    version: info.version,
    emptyConfigPath: path.join(dataDir, '.git', 'empty-gitconfig'),
  })
  const repo = new ShadowRepository({
    dir: path.join(dataDir, 'shadows', workspaceKey(workspace), 'repo.git'),
    workTree: workspace,
    git,
  })
  await repo.ensure({ excludeText: buildExcludeText(config) })
  return repo
}

test('git is detected and reports a version', { skip }, async () => {
  const info = await makeGit()
  assert.equal(info.executable, 'git')
  assert.match(info.version, /^\d+\.\d+/)
  assert.equal(info.compatible, true)
})

test('workspaceKey is stable and separates workspaces', { skip }, () => {
  const a = workspaceKey('F:/demo/project')
  const b = workspaceKey('F:\\demo\\project\\')
  const c = workspaceKey('F:/demo/project-2')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9a-f]{8}-project$/)
})

test('snapshot commits the complete work tree and restores it exactly', { skip }, async () => {
  const workspace = makeWorkspace({
    'a.txt': 'a0',
    'src/app.js': 'v0',
    '.gitignore': 'ignored-dir/\n',
    'ignored-dir/big.bin': 'ignored',
  })
  const dataDir = makeTempDir('dsh-all-rewind-git-')
  try {
    const repo = await makeRepo(workspace, dataDir)

    const first = await repo.snapshot({ message: 'before-chat-turn-1' })
    assert.match(first.commit, /^[0-9a-f]{40}$/)
    assert.equal(first.reused, false)
    assert.equal(await repo.head(), first.commit)

    // Turn 1 mutates the workspace: modify, delete, create.
    writeFiles(workspace, { 'a.txt': 'a1', 'created.txt': 'by ai', 'src/app.js': 'v1' })
    fs.rmSync(path.join(workspace, 'ignored-dir'), { recursive: true, force: true })
    fs.rmSync(path.join(workspace, 'src'), { recursive: true, force: true })

    const second = await repo.snapshot({ message: 'before-chat-turn-2' })
    assert.notEqual(second.commit, first.commit)
    assert.ok(second.filesChanged >= 3)

    const preview = await repo.previewRestore(first.commit)
    assert.ok(preview.restored.includes('a.txt'))
    assert.ok(preview.restored.includes('src/app.js'))
    assert.ok(preview.removed.includes('created.txt'))

    const result = await repo.restore(first.commit)
    assert.deepEqual(result.removed, preview.removed)
    assert.equal(readFile(workspace, 'a.txt'), 'a0')
    assert.equal(readFile(workspace, 'src/app.js'), 'v0')
    assert.equal(exists(workspace, 'created.txt'), false)
    // Ignored files are never snapshotted, so a restore cannot delete them.
    assert.equal(exists(workspace, 'ignored-dir'), false)
    // The workspace's own .gitignore is restored like any other file.
    assert.equal(readFile(workspace, '.gitignore'), 'ignored-dir/\n')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('ignored directories are never captured and never touched by a restore', { skip }, async () => {
  const workspace = makeWorkspace({
    'keep.txt': 'v0',
    'node_modules/pkg/index.js': 'dependency',
  })
  const dataDir = makeTempDir('dsh-all-rewind-git-')
  try {
    const repo = await makeRepo(workspace, dataDir)
    const first = await repo.snapshot({ message: 'baseline' })
    fs.writeFileSync(path.join(workspace, 'node_modules', 'pkg', 'index.js'), 'changed dependency')
    writeFiles(workspace, { 'keep.txt': 'v1' })
    await repo.snapshot({ message: 'turn 2' })
    await repo.restore(first.commit)
    assert.equal(readFile(workspace, 'keep.txt'), 'v0')
    assert.equal(readFile(workspace, 'node_modules/pkg/index.js'), 'changed dependency')
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('a workspace that is itself a git repository keeps its .git untouched', { skip }, async () => {
  const workspace = makeWorkspace({ 'readme.md': 'v0' })
  const dataDir = makeTempDir('dsh-all-rewind-git-')
  try {
    const { spawnSync } = await import('node:child_process')
    spawnSync('git', ['init', '-q'], { cwd: workspace })
    spawnSync('git', ['add', '-A'], { cwd: workspace })
    spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: workspace })
    const userHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).stdout.trim()
    const userIndex = fs.readFileSync(path.join(workspace, '.git', 'index'))

    const repo = await makeRepo(workspace, dataDir)
    const first = await repo.snapshot({ message: 'baseline' })
    writeFiles(workspace, { 'readme.md': 'v1' })
    await repo.snapshot({ message: 'turn 2' })
    await repo.restore(first.commit)

    assert.equal(readFile(workspace, 'readme.md'), 'v0')
    const afterHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).stdout.trim()
    assert.equal(afterHead, userHead, 'the user repository HEAD is untouched')
    assert.deepEqual(fs.readFileSync(path.join(workspace, '.git', 'index')), userIndex, 'the user index is untouched')
    assert.equal(exists(workspace, '.git'), true)
    assert.equal(await repo.hasCommit(first.commit), true)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('an unchanged tree reuses the previous commit instead of duplicating it', { skip }, async () => {
  const workspace = makeWorkspace({ 'a.txt': 'same' })
  const dataDir = makeTempDir('dsh-all-rewind-git-')
  try {
    const repo = await makeRepo(workspace, dataDir)
    const first = await repo.snapshot({ message: 'turn 1' })
    const second = await repo.snapshot({ message: 'turn 2' })
    assert.equal(second.commit, first.commit)
    assert.equal(second.reused, true)
    assert.equal(second.filesChanged, 0)
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('git gc packs objects and the history keeps restoring', { skip }, async () => {
  const workspace = makeWorkspace({ 'big.txt': 'line\n'.repeat(2000) })
  const dataDir = makeTempDir('dsh-all-rewind-git-')
  try {
    const repo = await makeRepo(workspace, dataDir)
    const first = await repo.snapshot({ message: 'turn 1' })
    for (let index = 0; index < 5; index += 1) {
      writeFiles(workspace, { 'big.txt': `${'line\n'.repeat(2000)}edit-${index}\n` })
      await repo.snapshot({ message: `turn ${index + 2}` })
    }
    const before = repo.sizeBytes()
    const gc = await repo.gc()
    assert.ok(gc.bytesBefore > 0)
    assert.ok(gc.bytesAfter > 0)
    assert.ok(fs.existsSync(path.join(repo.dir, 'objects', 'pack')), 'a pack directory exists after gc')
    assert.ok(before > 0)
    await repo.restore(first.commit)
    assert.equal(readFile(workspace, 'big.txt'), 'line\n'.repeat(2000))
  } finally {
    cleanup(workspace, dataDir)
  }
})

test('exclude text carries defaults and configured extra patterns', { skip }, () => {
  const config = resolveConfig({ ignoreDirs: ['custom-cache'], exclude: ['*.snap'] })
  const text = buildExcludeText(config)
  assert.match(text, /node_modules\//)
  assert.match(text, /custom-cache\//)
  assert.match(text, /\*\.snap/)
  assert.match(text, /\.git\//)
})

test('a workspace directory that disappears fails the snapshot without hanging', { skip }, async () => {
  const workspace = makeWorkspace({ 'a.txt': 'x' })
  const dataDir = makeTempDir('dsh-all-rewind-git-')
  try {
    const repo = await makeRepo(workspace, dataDir)
    fs.rmSync(workspace, { recursive: true, force: true })
    await assert.rejects(() => repo.snapshot({ message: 'gone' }))
  } finally {
    cleanup(workspace, dataDir)
  }
})
