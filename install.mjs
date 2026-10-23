#!/usr/bin/env node
// Install / uninstall dsh-all-rewind into a local DSH profile.
//
//   node install.mjs                                  # install into `desktop`
//   node install.mjs --profile web                    # another profile name
//   node install.mjs --data-dir E:/rewind-repo        # custom shadow git storage
//   node install.mjs --source ./pkg                   # copy a different package
//                                                     # (e.g. an npm-extracted copy)
//   node install.mjs --dry-run                        # show what would change
//   node install.mjs --uninstall                      # remove entry + copied files
//
// It copies this package into <profile>/node_modules/dsh-all-rewind and appends
// a managed block to <profile>/cordis.patch.yml (with a timestamped backup).
// Restart DSH afterwards so the loader picks the entry up.
//
// The plugin needs a `git` executable (2.13+) on PATH; set `gitExecutable` in
// the plugin config when git lives elsewhere. Storage location can be changed
// without reinstalling:
//   - `config.dataDir` in cordis.patch.yml (absolute, ~/..., or relative to $DSH_HOME)
//   - env `DSH_ALL_REWIND_DIR`
//   - fallback: $DSH_HOME/dsh-all-rewind
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'dsh-all-rewind'
const LEGACY_PACKAGE_NAME = 'dsh-trae-rewind'
const MARKER_BEGIN = '# >>> dsh-all-rewind (managed by install.mjs)'
const MARKER_END = '# <<< dsh-all-rewind'
// The project used to be published as `dsh-trae-rewind`; clean up its block so an
// upgrade does not leave two plugin entries behind.
const LEGACY_MARKER_BEGIN = '# >>> dsh-trae-rewind (managed by install.mjs)'
const LEGACY_MARKER_END = '# <<< dsh-trae-rewind'
const COPY_ENTRIES = [
  'package.json', 'dsh-plugin.json', 'cordis.patch.yml', 'icon.png',
  'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'lib', 'assets',
]

function parseArgs(argv) {
  const args = { profile: 'desktop', dryRun: false, uninstall: false, dataDir: undefined, source: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') {
      args.profile = argv[index + 1]
      index += 1
    } else if (arg === '--data-dir' || arg === '--dataDir') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--data-dir needs a value')
      }
      args.dataDir = value
      index += 1
    } else if (arg === '--source' || arg === '--from') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--source needs a path')
      }
      args.source = value
      index += 1
    } else if (arg === '--dry-run' || arg === '-n') {
      args.dryRun = true
    } else if (arg === '--uninstall') {
      args.uninstall = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node install.mjs [--profile <name>] [--data-dir <path>] [--source <dir>] [--dry-run] [--uninstall]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!args.profile) throw new Error('--profile needs a value')
  if (args.dataDir !== undefined && (!args.dataDir || !String(args.dataDir).trim())) {
    throw new Error('--data-dir needs a value')
  }
  return args
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function profileDir(profile) {
  return process.env.DSH_PROFILE_DIR || path.join(dshHome(), 'profiles', profile)
}

function copyPackage(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of COPY_ENTRIES) {
    const from = path.join(source, entry)
    if (!fs.existsSync(from)) continue
    const to = path.join(target, entry)
    fs.rmSync(to, { recursive: true, force: true })
    fs.cpSync(from, to, { recursive: true })
  }
}

/** Managed patch block; includes `dataDir` only when explicitly requested. */
function patchEntry(dataDir) {
  const lines = [
    MARKER_BEGIN,
    '- insert:',
    `    - id: ${PACKAGE_NAME}`,
    `      name: ${PACKAGE_NAME}`,
    '      config:',
  ]
  if (dataDir) lines.push(`        dataDir: ${JSON.stringify(String(dataDir))}`)
  lines.push('        keepTurns: 20', MARKER_END, '')
  return lines.join('\n')
}

/**
 * Config override for an already-mounted bundle entry (the profile's
 * `dsh.profile.bundles` loads the package, so another `insert` would create a
 * duplicate entry). Only written when a storage location must be configured.
 */
function patchOverride(dataDir) {
  const lines = [
    MARKER_BEGIN,
    '# The plugin is mounted through dsh.profile.bundles; this entry only overrides config.',
    `- id: ${PACKAGE_NAME}`,
    '  config:',
    `    dataDir: ${JSON.stringify(String(dataDir))}`,
    '    keepTurns: 20',
    MARKER_END,
    '',
  ]
  return lines.join('\n')
}

/** Whether the profile already mounts this package as a bundle. */
function profileBundles(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles : []
  } catch {
    return []
  }
}

/** Remove the managed block entirely (used when a bundle already mounts the plugin). */
function removeManagedBlock(text) {
  const begin = text.indexOf(MARKER_BEGIN)
  const end = text.indexOf(MARKER_END)
  if (begin < 0 || end < begin) return undefined
  const before = text.slice(0, begin).trimEnd()
  const after = text.slice(end + MARKER_END.length).replace(/^\s*\n/, '')
  const joined = before && after ? `${before}\n\n${after}` : (before || after)
  return joined.trimEnd() ? `${joined.trimEnd()}\n` : ''
}

/** Report the git executable version the plugin will use (best effort). */
function detectGit(executable = 'git') {
  try {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 15_000 })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    const match = /git version (\d+\.\d+(?:\.\d+)?)/i.exec(output)
    if (result.status !== 0 || !match) return { available: false, executable, error: output || `exit ${result.status}` }
    const version = match[1]
    const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
    return {
      available: true,
      executable,
      version,
      compatible: major > 2 || (major === 2 && minor >= 13),
    }
  } catch (error) {
    return { available: false, executable, error: error.message }
  }
}

/** Remove a block written by the old dsh-trae-rewind installer, if present. */
function stripLegacyBlock(text) {
  const begin = text.indexOf(LEGACY_MARKER_BEGIN)
  const end = text.indexOf(LEGACY_MARKER_END)
  if (begin < 0 || end < begin) return { text, removed: false }
  const before = text.slice(0, begin).trimEnd()
  const after = text.slice(end + LEGACY_MARKER_END.length).replace(/^\s*\n/, '')
  const joined = before && after ? `${before}\n\n${after}` : (before || after)
  return { text: joined.trimEnd() ? `${joined.trimEnd()}\n` : '', removed: true }
}

/** Read the dataDir configured by a legacy dsh-trae-rewind block. */
function extractManagedDataDirFromLegacy(text) {
  const begin = text.indexOf(LEGACY_MARKER_BEGIN)
  const end = text.indexOf(LEGACY_MARKER_END)
  if (begin < 0 || end < begin) return undefined
  const match = /dataDir:\s*("(?:[^"\\]|\\.)*")/.exec(text.slice(begin, end))
  if (!match) return undefined
  try {
    return JSON.parse(match[1])
  } catch {
    return undefined
  }
}

/** Read back the dataDir a previous managed block configured. */
function extractManagedDataDir(text) {
  const begin = text.indexOf(MARKER_BEGIN)
  const end = text.indexOf(MARKER_END)
  if (begin < 0 || end < begin) return undefined
  const match = /dataDir:\s*("(?:[^"\\]|\\.)*")/.exec(text.slice(begin, end))
  if (!match) return undefined
  try {
    return JSON.parse(match[1])
  } catch {
    return undefined
  }
}

/** Replace an existing managed block, or return undefined when none exists. */
function replaceManagedBlock(text, block) {
  const begin = text.indexOf(MARKER_BEGIN)
  const end = text.indexOf(MARKER_END)
  if (begin < 0 || end < begin) return undefined
  const before = text.slice(0, begin).trimEnd()
  const after = text.slice(end + MARKER_END.length).replace(/^\s*\n/, '')
  return `${before ? `${before}\n\n` : ''}${block}${after ? `\n${after.trimStart()}` : ''}`.trimEnd() + '\n'
}

/** Resolve the package directory to copy (defaults to this checkout). */
function resolveSourceDir(source) {
  const sourceDir = source ? path.resolve(source) : PACKAGE_ROOT
  const manifestFile = path.join(sourceDir, 'package.json')
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`--source is not a package directory (missing package.json): ${sourceDir}`)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (manifest.name && manifest.name !== PACKAGE_NAME) {
    throw new Error(`--source package is "${manifest.name}", expected "${PACKAGE_NAME}"`)
  }
  return sourceDir
}

function install({ profile, dryRun, dataDir, source }) {
  const sourceDir = resolveSourceDir(source)
  const dir = profileDir(profile)
  if (!fs.existsSync(dir)) {
    throw new Error(`profile directory not found: ${dir}\nStart DeepSeek Harness once with --profile ${profile} first, or set DSH_PROFILE_DIR.`)
  }
  const patchFile = path.join(dir, 'cordis.patch.yml')
  const target = path.join(dir, 'node_modules', PACKAGE_NAME)
  let current = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
  const legacyDataDir = extractManagedDataDirFromLegacy(current)
  const legacy = stripLegacyBlock(current)
  if (legacy.removed) {
    current = legacy.text
    if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
    fs.writeFileSync(patchFile, current, 'utf8')
    console.log('removed the legacy dsh-trae-rewind entry from cordis.patch.yml')
  }
  const legacyDir = path.join(dir, 'node_modules', LEGACY_PACKAGE_NAME)
  if (fs.existsSync(legacyDir)) {
    fs.rmSync(legacyDir, { recursive: true, force: true })
    console.log(`removed legacy package directory ${legacyDir}`)
  }
  // Re-installing without --data-dir keeps the location configured last time
  // (including a location carried over from the legacy entry).
  const effectiveDataDir = dataDir ?? extractManagedDataDir(current) ?? legacyDataDir
  const bundleMounted = profileBundles(dir).includes(PACKAGE_NAME)
  const block = bundleMounted
    ? (effectiveDataDir ? patchOverride(effectiveDataDir) : '')
    : patchEntry(effectiveDataDir)
  const git = detectGit()

  console.log(`profile:   ${dir}`)
  console.log(`package:   ${target}`)
  console.log(`patch:     ${patchFile}`)
  console.log(`mount:     ${bundleMounted ? 'bundle (dsh.profile.bundles)' : 'patch insert (install.mjs)'}`)
  if (effectiveDataDir) console.log(`storage:   ${effectiveDataDir}`)
  if (git.available) {
    console.log(`git:       ${git.executable} ${git.version}${git.compatible ? '' : '  (warning: git 2.13+ recommended)'}`)
  } else {
    console.log(`git:       NOT FOUND — the plugin needs git on PATH (${git.error})`)
    console.log('           install Git, or set config.gitExecutable in cordis.patch.yml')
  }

  if (dryRun) {
    console.log('\n[dry run] would copy the package and write this patch block:')
    console.log(block || '(nothing: the bundle already mounts the plugin)')
    return
  }

  copyPackage(sourceDir, target)
  console.log(`copied ${PACKAGE_NAME} -> ${target}`)

  if (bundleMounted) {
    if (effectiveDataDir) {
      const managed = replaceManagedBlock(current, block)
      if (managed !== undefined) {
        if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
        fs.writeFileSync(patchFile, managed, 'utf8')
        console.log('replaced the insert block with a config override (the bundle already mounts the plugin)')
      } else if (!current.includes(`- id: ${PACKAGE_NAME}`)) {
        if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
        fs.writeFileSync(patchFile, `${current.trimEnd()}${current.trimEnd() ? '\n\n' : ''}${block}`, 'utf8')
        console.log('appended a config override for the mounted bundle')
      } else {
        console.log('warning: an unmanaged dsh-all-rewind entry already exists;')
        console.log('         edit cordis.patch.yml manually to set dataDir.')
      }
    } else {
      const stripped = removeManagedBlock(current)
      if (stripped !== undefined) {
        if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
        fs.writeFileSync(patchFile, stripped, 'utf8')
        console.log('removed the redundant insert block (the bundle already mounts the plugin)')
      } else {
        console.log('the profile bundle already mounts the plugin; no insert block needed')
      }
    }
    console.log('\nRestart DeepSeek Harness to load the plugin.')
    return
  }

  const managed = replaceManagedBlock(current, block)
  if (managed !== undefined) {
    if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
    fs.writeFileSync(patchFile, managed, 'utf8')
    console.log('updated the managed plugin entry in cordis.patch.yml')
  } else if (current.includes(`name: ${PACKAGE_NAME}`)) {
    if (dataDir) {
      console.log('warning: existing entry is not managed by install.mjs markers;')
      console.log('         edit cordis.patch.yml manually to set dataDir.')
    } else {
      console.log('cordis.patch.yml already has the plugin entry (left unchanged)')
    }
  } else {
    if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
    fs.writeFileSync(patchFile, `${current.trimEnd()}${current.trimEnd() ? '\n\n' : ''}${block}`, 'utf8')
    console.log('appended the plugin entry to cordis.patch.yml')
  }
  console.log('\nRestart DeepSeek Harness to load the plugin.')
}

function uninstall({ profile, dryRun }) {
  const dir = profileDir(profile)
  const patchFile = path.join(dir, 'cordis.patch.yml')
  const target = path.join(dir, 'node_modules', PACKAGE_NAME)
  const bundleMounted = profileBundles(dir).includes(PACKAGE_NAME)
  console.log(`profile:   ${dir}`)
  console.log(`mount:     ${bundleMounted ? 'bundle (dsh.profile.bundles)' : 'patch insert (install.mjs)'}`)
  if (dryRun) {
    console.log('[dry run] would remove the managed patch block'
      + (bundleMounted ? ' (the pnpm-installed package is kept)' : ' and the copied package'))
    return
  }
  if (fs.existsSync(patchFile)) {
    const text = fs.readFileSync(patchFile, 'utf8')
    const begin = text.indexOf(MARKER_BEGIN)
    const end = text.indexOf(MARKER_END)
    let next = text
    if (begin >= 0 && end > begin) {
      next = `${text.slice(0, begin).trimEnd()}\n${text.slice(end + MARKER_END.length).replace(/^\s*\n/, '')}`
    } else {
      // Tolerate a hand-added entry written without markers.
      next = text.replace(/\n- insert:\n\s+- id: dsh-all-rewind\n(?:.*\n)*?\s+- id: |\n- insert:\n\s+- id: dsh-all-rewind\n(?:.*\n)*?(?=\n- |\s*$)/g, '\n')
    }
    if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
    fs.writeFileSync(patchFile, next.trimEnd() ? `${next.trimEnd()}\n` : '', 'utf8')
    console.log('removed the plugin entry from cordis.patch.yml')
  }
  if (bundleMounted) {
    console.log(`kept ${target}: the profile still lists the package in dsh.profile.bundles.`)
    console.log('Remove it with the plugin manager (or delete the dependency + bundle entry), then restart.')
    return
  }
  fs.rmSync(target, { recursive: true, force: true })
  const legacyDir = path.join(dir, 'node_modules', LEGACY_PACKAGE_NAME)
  if (fs.existsSync(legacyDir)) {
    fs.rmSync(legacyDir, { recursive: true, force: true })
    console.log(`removed legacy package directory ${legacyDir}`)
  }
  console.log(`removed ${target}`)
  console.log('\nRestart DeepSeek Harness to unload the plugin.')
}

export {
  install, uninstall, parseArgs, profileDir, copyPackage, patchEntry, patchOverride,
  replaceManagedBlock, removeManagedBlock, profileBundles, extractManagedDataDir,
  resolveSourceDir, stripLegacyBlock, extractManagedDataDirFromLegacy, detectGit,
}

// Only run when executed directly (`node install.mjs`), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.uninstall) uninstall(args)
    else install(args)
  } catch (error) {
    console.error(`install failed: ${error.message}`)
    process.exit(1)
  }
}
