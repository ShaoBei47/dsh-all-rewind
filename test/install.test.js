// Install/uninstall behaviour for the profile patcher. No child processes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { install, uninstall, parseArgs, resolveSourceDir } from '../install.mjs'
import { cleanup, makeTempDir } from './helpers.mjs'

function makeProfile() {
  const dir = makeTempDir('dsh-all-rewind-profile-')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), [
    '# user patch layer',
    '- id: ui-theme',
    '  name: "@deepseek-ai/dsh-client-ui-theme"',
    '  config:',
    '    preference: dark',
    '',
  ].join('\n'))
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  return dir
}

function withProfileDir(dir, fn) {
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
}

test('parseArgs accepts profile/dry-run/uninstall and rejects junk', () => {
  assert.deepEqual(parseArgs(['--profile', 'web', '--dry-run']), {
    profile: 'web', dryRun: true, uninstall: false, dataDir: undefined, source: undefined,
  })
  assert.deepEqual(parseArgs(['--uninstall']), {
    profile: 'desktop', dryRun: false, uninstall: true, dataDir: undefined, source: undefined,
  })
  assert.equal(parseArgs(['--source', 'D:/pkg']).source, 'D:/pkg')
  assert.throws(() => parseArgs(['--source']), /--source needs a path/)
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/)
})

test('install copies the package and appends exactly one managed patch block', () => {
  const profile = makeProfile()
  const originalLog = console.log
  console.log = () => {}
  try {
    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: false }))
    const target = path.join(profile, 'node_modules', 'dsh-all-rewind')
    assert.ok(fs.existsSync(path.join(target, 'package.json')))
    assert.ok(fs.existsSync(path.join(target, 'lib', 'index.js')))
    assert.ok(fs.existsSync(path.join(target, 'assets', 'ui.js')))
    const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /# user patch layer/)
    assert.equal((patch.match(/- id: dsh-all-rewind/g) ?? []).length, 1)
    assert.ok(fs.readdirSync(profile).some((name) => name.startsWith('cordis.patch.yml.bak-')))

    // Idempotent: a second install must not duplicate the entry.
    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: false }))
    const patchAgain = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.equal((patchAgain.match(/- id: dsh-all-rewind/g) ?? []).length, 1)
  } finally {
    console.log = originalLog
    cleanup(profile)
  }
})

test('dry run changes nothing', () => {
  const profile = makeProfile()
  const before = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  const originalLog = console.log
  console.log = () => {}
  try {
    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: true }))
    assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), before)
    assert.ok(!fs.existsSync(path.join(profile, 'node_modules', 'dsh-all-rewind')))
  } finally {
    console.log = originalLog
    cleanup(profile)
  }
})

test('uninstall restores the user patch untouched', () => {
  const profile = makeProfile()
  const original = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  const originalLog = console.log
  console.log = () => {}
  try {
    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: false }))
    withProfileDir(profile, () => uninstall({ profile: 'desktop', dryRun: false }))
    assert.ok(!fs.existsSync(path.join(profile, 'node_modules', 'dsh-all-rewind')))
    const after = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(after, /ui-theme/)
    assert.ok(!after.includes('dsh-all-rewind'))
    assert.equal(after.trim(), original.trim())
  } finally {
    console.log = originalLog
    cleanup(profile)
  }
})

test('install fails clearly when the profile does not exist', () => {
  const missing = path.join(os.tmpdir(), `dsh-all-rewind-missing-${Date.now()}`)
  assert.throws(
    () => withProfileDir(missing, () => install({ profile: 'desktop', dryRun: false })),
    /profile directory not found/,
  )
})

test('--data-dir is parsed and written into the managed patch block', () => {
  assert.equal(parseArgs(['--data-dir', 'E:/rewind-snapshots']).dataDir, 'E:/rewind-snapshots')
  assert.throws(() => parseArgs(['--data-dir']), /--data-dir needs a value/)

  const profile = makeProfile()
  const originalLog = console.log
  console.log = () => {}
  try {
    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: false, dataDir: 'E:/rewind-snapshots' }))
    const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /dataDir: "E:\/rewind-snapshots"/)
    assert.match(patch, /keepTurns: 20/)
    assert.equal((patch.match(/- id: dsh-all-rewind/g) ?? []).length, 1)

    // Re-installing with a different location updates the block in place.
    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: false, dataDir: 'G:/big-disk/rewind' }))
    const updated = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(updated, /dataDir: "G:\/big-disk\/rewind"/)
    assert.ok(!updated.includes('E:/rewind-snapshots'))
    assert.equal((updated.match(/- id: dsh-all-rewind/g) ?? []).length, 1)
    assert.match(updated, /ui-theme/, 'user entries retained')

    // Uninstall still restores the original user patch.
    withProfileDir(profile, () => uninstall({ profile: 'desktop', dryRun: false }))
    const after = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(!after.includes('dsh-all-rewind'))
    assert.match(after, /ui-theme/)
  } finally {
    console.log = originalLog
    cleanup(profile)
  }
})


test('re-installing without --data-dir preserves the configured location', () => {
  const profile = makeProfile()
  const originalLog = console.log
  console.log = () => {}
  try {
    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: false, dataDir: 'E:/keep-me' }))
    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: false }))
    const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /dataDir: "E:\/keep-me"/)
    assert.equal((patch.match(/dataDir:/g) ?? []).length, 1)
    assert.equal((patch.match(/- id: dsh-all-rewind/g) ?? []).length, 1)
  } finally {
    console.log = originalLog
    cleanup(profile)
  }
})


test('--source installs from an external package directory (npm-extracted copy)', () => {
  const source = makeTempDir('dsh-all-rewind-src-')
  const profile = makeProfile()
  const originalLog = console.log
  console.log = () => {}
  try {
    // A minimal package that looks like an npm-extracted dsh-all-rewind.
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'dsh-all-rewind', version: '0.3.0' }))
    fs.mkdirSync(path.join(source, 'lib'))
    fs.writeFileSync(
      path.join(source, 'lib', 'index.js'),
      ['export default { name: "dsh-all-rewind", apply() {} }', ''].join('\n'),
    )
    fs.mkdirSync(path.join(source, 'assets'))
    fs.writeFileSync(path.join(source, 'assets', 'ui.js'), '/* ui */')
    fs.writeFileSync(path.join(source, 'cordis.patch.yml'), '- insert: []\n')

    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: false, source }))
    const installed = path.join(profile, 'node_modules', 'dsh-all-rewind')
    assert.equal(fs.readFileSync(path.join(installed, 'lib', 'index.js'), 'utf8').includes('apply'), true)
    assert.equal(fs.existsSync(path.join(installed, 'assets', 'ui.js')), true)

    const wrong = makeTempDir('dsh-all-rewind-badsrc-')
    fs.writeFileSync(path.join(wrong, 'package.json'), JSON.stringify({ name: 'not-this-plugin' }))
    assert.throws(() => resolveSourceDir(wrong), /expected "dsh-all-rewind"/)
    cleanup(wrong)
  } finally {
    console.log = originalLog
    cleanup(source, profile)
  }
})

test('upgrading from dsh-trae-rewind cleans the legacy entry and carries dataDir over', () => {
  const profile = makeProfile()
  const patchFile = path.join(profile, 'cordis.patch.yml')
  const legacyBlock = [
    '# >>> dsh-trae-rewind (managed by install.mjs)',
    '- insert:',
    '    - id: dsh-trae-rewind',
    '      name: dsh-trae-rewind',
    '      config:',
    '        dataDir: "E:/old-snapshots"',
    '        keepTurns: 20',
    '# <<< dsh-trae-rewind',
    '',
  ].join('\n')
  fs.appendFileSync(patchFile, `\n${legacyBlock}`)
  const legacyPackage = path.join(profile, 'node_modules', 'dsh-trae-rewind')
  fs.mkdirSync(legacyPackage, { recursive: true })
  fs.writeFileSync(path.join(legacyPackage, 'package.json'), JSON.stringify({ name: 'dsh-trae-rewind' }))

  const originalLog = console.log
  const logs = []
  console.log = (message) => logs.push(String(message))
  try {
    withProfileDir(profile, () => install({ profile: 'desktop', dryRun: false }))
    const patch = fs.readFileSync(patchFile, 'utf8')
    assert.ok(!patch.includes('dsh-trae-rewind'), 'legacy block removed')
    assert.ok(patch.includes('dsh-all-rewind'), 'new block present')
    assert.match(patch, /dataDir: "E:\/old-snapshots"/, 'legacy dataDir carried over')
    assert.equal(fs.existsSync(legacyPackage), false, 'legacy package directory removed')
    assert.equal(fs.existsSync(path.join(profile, 'node_modules', 'dsh-all-rewind', 'package.json')), true)
    assert.equal((patch.match(/- id: dsh-all-rewind/g) ?? []).length, 1)
    assert.ok(logs.some((line) => line.includes('legacy')), 'migration logged')
  } finally {
    console.log = originalLog
    cleanup(profile)
  }
})
