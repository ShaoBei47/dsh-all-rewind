// Shadow-git engine.
//
// Every DSH workspace gets a private git repository ("shadow repository") that
// lives outside the workspace, under the plugin data directory. It is used as a
// content store only: `git add` writes the complete working tree (respecting the
// workspace's `.gitignore`, plus our own exclude file) into the shadow repository,
// and one commit is made per conversation turn - right before the Agent runs, so
// the commit is the exact state the turn started from.
//
// The user's own repository (if the workspace is one) is never touched: our
// index, objects and refs live in the shadow `GIT_DIR`, while `--work-tree`
// points at the workspace for `add` / `read-tree`. That is the same trick DSH's
// own workspace-changes recorder uses, except this store is durable instead of
// session-scoped.
//
// Git is much smaller than keeping a copy of every changed file because
// unchanged blobs/trees are content-addressed and later versions delta-compress
// against earlier ones during `git gc`.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, errorMessage, writeFileIfChanged } from './util.js'

export const MIN_GIT_VERSION = '2.13.0'
export const DEFAULT_GIT_TIMEOUT_MS = 120_000
const STDERR_LIMIT = 32 * 1024
const STDOUT_LIMIT = 32 * 1024 * 1024

export class GitError extends Error {
  constructor(message, { code = 'GIT_ERROR', stdout = '', stderr = '', exitCode = null } = {}) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

export class GitUnavailableError extends GitError {
  constructor(message, details) {
    super(message, { ...details, code: 'GIT_UNAVAILABLE' })
    this.name = 'GitUnavailableError'
  }
}

/** Run one child process and collect bounded output. */
function runProcess(file, args, { cwd, env, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          try { child.kill('SIGKILL') } catch {}
        }, timeoutMs)
      : undefined
    const onAbort = () => {
      try { child.kill('SIGKILL') } catch {}
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result)
    }
    child.stdout?.on('data', (chunk) => {
      if (stdoutBytes >= STDOUT_LIMIT) return
      stdoutBytes += chunk.length
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (stderrBytes >= STDERR_LIMIT) return
      stderrBytes += chunk.length
      stderr.push(chunk)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      finish(null, {
        exitCode: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    })
  })
}

/** Compare two dotted numeric versions; missing parts count as zero. */
function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Locate a usable git executable and report its version.
 * @param {string} [executable]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ executable: string, version: string, compatible: boolean }>}
 */
export async function detectGit(executable = 'git', { timeoutMs = 15_000 } = {}) {
  let result
  try {
    result = await runProcess(executable, ['--version'], { timeoutMs, env: baseEnvironment() })
  } catch (error) {
    throw new GitUnavailableError(
      `git executable "${executable}" could not be started: ${errorMessage(error)}`,
      { stderr: errorMessage(error) },
    )
  }
  if (result.timedOut) {
    throw new GitUnavailableError(`git executable "${executable}" timed out while reporting its version`)
  }
  const output = `${result.stdout}${result.stderr}`
  const match = /git version (\d+\.\d+(?:\.\d+)?)/i.exec(output)
  if (result.exitCode !== 0 || !match) {
    throw new GitUnavailableError(
      `"${executable} --version" did not report a git version (exit ${result.exitCode}): ${output.trim()}`,
      { stderr: result.stderr },
    )
  }
  const version = match[1]
  return {
    executable,
    version,
    compatible: compareVersions(version, MIN_GIT_VERSION) >= 0,
  }
}

/** Environment shared by every shadow git command. */
function baseEnvironment(extra = {}) {
  const env = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
  ]) {
    delete env[key]
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = 'dsh-all-rewind'
  env.GIT_AUTHOR_EMAIL = 'dsh-all-rewind@localhost'
  env.GIT_COMMITTER_NAME = 'dsh-all-rewind'
  env.GIT_COMMITTER_EMAIL = 'dsh-all-rewind@localhost'
  env.LC_ALL = 'C'
  env.LANG = 'C'
  return { ...env, ...extra }
}

export class GitRunner {
  /**
   * @param {object} options
   * @param {string} options.executable
   * @param {string} options.version
   * @param {string} options.emptyConfigPath file used as GIT_CONFIG_GLOBAL so the
   *   user's global git config never changes how a snapshot is stored
   * @param {number} [options.timeoutMs]
   * @param {(message: string, level?: string) => void} [options.log]
   */
  constructor({ executable, version, emptyConfigPath, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, log }) {
    this.executable = executable
    this.version = version
    this.timeoutMs = timeoutMs
    this.log = log ?? (() => {})
    ensureDir(path.dirname(emptyConfigPath))
    writeFileIfChanged(emptyConfigPath, '')
    this.baseEnv = baseEnvironment({ GIT_CONFIG_GLOBAL: emptyConfigPath })
  }

  /**
   * Run one git command. Never shell-interpreted; never inherits GIT_DIR.
   * @param {string[]} args
   * @param {{ cwd?: string, env?: Record<string, string>, timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean }>}
   */
  async run(args, { cwd, env = {}, timeoutMs, signal } = {}) {
    const rendered = args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')
    let result
    try {
      result = await runProcess(this.executable, args, {
        cwd,
        env: { ...this.baseEnv, ...env },
        timeoutMs: timeoutMs ?? this.timeoutMs,
        signal,
      })
    } catch (error) {
      throw new GitError(`git ${args[0]} failed to start: ${errorMessage(error)}`, {
        code: 'GIT_UNAVAILABLE',
        stderr: errorMessage(error),
      })
    }
    if (result.timedOut) {
      throw new GitError(`git ${rendered} timed out`, {
        code: 'GIT_TIMEOUT',
        stdout: result.stdout,
        stderr: result.stderr,
      })
    }
    return result
  }

  /** Run and reject on a non-zero exit code. */
  async must(args, options) {
    const result = await this.run(args, options)
    if (result.exitCode !== 0) {
      throw new GitError(
        `git ${args.slice(0, 3).join(' ')} exited with ${result.exitCode}: ${tail(result.stderr) || tail(result.stdout)}`,
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      )
    }
    return result
  }
}

function tail(text, limit = 600) {
  const value = String(text ?? '').trim()
  return value.length <= limit ? value : `…${value.slice(-limit)}`
}

/** Exclude file written into every shadow repository. */
export function buildExcludeText({ ignoreDirs = [], ignoreFiles = [], extraExcludes = [] } = {}) {
  const lines = [
    '# dsh-all-rewind shadow-repository exclude rules (managed)',
    '# Ignored paths are never snapshotted; they are also never reverted.',
    '.git/',
    ...ignoreDirs.map((dir) => normalizeIgnoreDirectory(dir)),
    ...ignoreFiles.map((file) => String(file)),
    ...extraExcludes.map((entry) => String(entry)),
    '',
  ]
  return lines.join('\n')
}

function normalizeIgnoreDirectory(dir) {
  const value = String(dir).replace(/^[/\\]+/, '').replace(/\\/g, '/')
  if (!value) return ''
  return value.endsWith('/') ? value : `${value}/`
}

/**
 * One workspace's shadow repository: private `GIT_DIR` + the workspace as work
 * tree. All commands are serialized by the caller (one queue per workspace).
 */
export class ShadowRepository {
  /**
   * @param {object} options
   * @param {string} options.dir absolute path of the shadow `GIT_DIR`
   * @param {string} options.workTree absolute workspace path
   * @param {GitRunner} options.git
   */
  constructor({ dir, workTree, git }) {
    this.dir = dir
    this.workTree = workTree
    this.git = git
    this.excludeSignature = null
  }

  prefix() {
    return ['--git-dir', this.dir, '--work-tree', this.workTree]
  }

  /**
   * Create and configure the repository when it does not exist yet.
   * @param {{ excludeText?: string, gitTimeoutMs?: number }} [options]
   */
  async ensure({ excludeText, gitTimeoutMs } = {}) {
    if (!fs.existsSync(path.join(this.dir, 'HEAD'))) {
      ensureDir(path.dirname(this.dir))
      await this.git.must(['init', '--quiet', '--bare', this.dir], { timeoutMs: gitTimeoutMs })
      await this.git.must(['--git-dir', this.dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { timeoutMs: gitTimeoutMs })
      const settings = [
        ['core.bare', 'false'],
        ['core.worktree', this.workTree],
        ['core.autocrlf', 'false'],
        ['core.safecrlf', 'false'],
        ['core.fileMode', 'false'],
        ['core.symlinks', 'false'],
        ['core.longpaths', 'true'],
        ['core.quotepath', 'false'],
        ['core.fsmonitor', 'false'],
        ['core.untrackedCache', 'false'],
        ['core.preloadIndex', 'true'],
        ['gc.auto', '0'],
        ['gc.autoDetach', 'false'],
        ['maintenance.auto', 'false'],
        ['commit.gpgsign', 'false'],
        ['tag.gpgsign', 'false'],
        ['filter.lfs.clean', 'cat'],
        ['filter.lfs.smudge', 'cat'],
        ['filter.lfs.required', 'false'],
        ['advice.detachedHead', 'false'],
      ]
      for (const [key, value] of settings) {
        await this.git.must(['--git-dir', this.dir, 'config', key, value], { timeoutMs: gitTimeoutMs })
      }
    }
    if (typeof excludeText === 'string') {
      const signature = String(excludeText)
      if (this.excludeSignature !== signature || !fs.existsSync(this.excludeFile())) {
        ensureDir(path.dirname(this.excludeFile()))
        writeFileIfChanged(this.excludeFile(), signature)
        this.excludeSignature = signature
      }
    }
  }

  excludeFile() {
    return path.join(this.dir, 'info', 'exclude')
  }

  /** @returns {Promise<string|undefined>} the `HEAD` commit, or undefined when unborn. */
  async head() {
    const result = await this.git.run(['--git-dir', this.dir, 'rev-parse', '--verify', '--quiet', 'HEAD'])
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  }

  /** Commit tree id (git object of the recorded state). */
  async treeOf(commit) {
    const result = await this.git.must(['--git-dir', this.dir, 'rev-parse', `${commit}^{tree}`])
    return result.stdout.trim()
  }

  /** Whether a commit object exists in this repository. */
  async hasCommit(commit) {
    if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(commit)) return false
    const result = await this.git.run(['--git-dir', this.dir, 'cat-file', '-e', `${commit}^{commit}`])
    return result.exitCode === 0
  }

  /**
   * Snapshot the complete working tree as a commit on `refs/heads/main`.
   * An unchanged tree reuses the current `HEAD` commit instead of writing a
   * duplicate commit, so a turn that touched no file costs one `git add`.
   * @param {{ message: string, gitTimeoutMs?: number, signal?: AbortSignal }} options
   * @returns {Promise<{ commit: string, tree: string, parent?: string, reused: boolean, filesChanged: number }>}
   */
  async snapshot({ message, gitTimeoutMs, signal }) {
    await this.ensure()
    const add = await this.git.run(
      [...this.prefix(), 'add', '--all', '--ignore-errors', '--', '.'],
      { cwd: this.workTree, timeoutMs: gitTimeoutMs, signal },
    )
    // Exit code 1 means "some paths could not be read and were skipped": the
    // index is still complete for everything else, which is the snapshot contract.
    if (add.exitCode !== 0 && add.exitCode !== 1) {
      throw new GitError(
        `git add exited with ${add.exitCode}: ${tail(add.stderr) || tail(add.stdout)}`,
        { stdout: add.stdout, stderr: add.stderr, exitCode: add.exitCode },
      )
    }
    const tree = (await this.git.must([...this.prefix(), 'write-tree'], { cwd: this.workTree, signal })).stdout.trim()
    const parent = await this.head()
    if (parent) {
      const parentTree = await this.treeOf(parent)
      if (parentTree === tree) {
        return { commit: parent, tree, reused: true, filesChanged: 0 }
      }
    }
    const args = ['--git-dir', this.dir, 'commit-tree', tree, '-m', message]
    if (parent) args.push('-p', parent)
    const commit = (await this.git.must(args, { signal })).stdout.trim()
    await this.git.must(['--git-dir', this.dir, 'update-ref', 'refs/heads/main', commit], { signal })
    const filesChanged = parent ? (await this.nameStatus(await this.treeOf(parent), tree)).length : 0
    return { commit, tree, parent, reused: false, filesChanged }
  }

  /**
   * Paths that differ between two trees (rename detection disabled so a rename is
   * a delete plus an add, which is what a restore must perform).
   * @returns {Promise<Array<{ status: 'A'|'M'|'D', path: string }>>}
   */
  async nameStatus(fromTree, toTree) {
    if (fromTree === toTree) return []
    const result = await this.git.must([
      '--git-dir', this.dir, 'diff-tree', '-r', '--no-renames', '--name-status', '-z', fromTree, toTree,
    ])
    const parts = result.stdout.split('\0').filter((entry) => entry.length > 0)
    const entries = []
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const status = parts[index][0]
      const file = parts[index + 1]
      if (status === 'A' || status === 'M' || status === 'D' || status === 'T') {
        entries.push({ status: status === 'T' ? 'M' : status, path: file })
      }
    }
    return entries
  }

  /**
   * Preview which paths a restore would rewrite/remove, without touching disk.
   * Direction: from the current `HEAD` tree back to `commit`.
   * @param {string} commit
   * @returns {Promise<{ restored: string[], removed: string[] }>}
   */
  async previewRestore(commit) {
    const head = await this.head()
    if (!head) return { restored: [], removed: [] }
    const headTree = await this.treeOf(head)
    const targetTree = await this.treeOf(commit)
    const entries = await this.nameStatus(targetTree, headTree)
    const restored = []
    const removed = []
    for (const entry of entries) {
      if (entry.status === 'A') removed.push(entry.path)
      else restored.push(entry.path)
    }
    return { restored, removed }
  }

  /**
   * Reset the working tree + index to exactly the tree of `commit`.
   * Files that are ignored or were never snapshotted are left alone.
   * @param {string} commit
   * @param {{ gitTimeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ restored: string[], removed: string[] }>}
   */
  async restore(commit, { gitTimeoutMs, signal } = {}) {
    const preview = await this.previewRestore(commit)
    const result = await this.git.run([...this.prefix(), 'read-tree', '-u', '--reset', commit], {
      cwd: this.workTree,
      timeoutMs: gitTimeoutMs,
      signal,
    })
    if (result.exitCode !== 0) {
      throw new GitError(
        `git read-tree exited with ${result.exitCode}: ${tail(result.stderr) || tail(result.stdout)}`,
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      )
    }
    return preview
  }

  /** On-disk size of the shadow repository (packed and loose objects). */
  sizeBytes() {
    return directorySize(this.dir)
  }

  /**
   * Rewrite loose objects into a pack so similar versions delta-compress.
   * All commits stay reachable from `refs/heads/main`, so nothing is lost.
   * @returns {Promise<{ bytesBefore: number, bytesAfter: number }>}
   */
  async gc({ gitTimeoutMs } = {}) {
    const bytesBefore = this.sizeBytes()
    await this.git.must(['--git-dir', this.dir, 'gc', '--quiet', '--prune=now'], { timeoutMs: gitTimeoutMs })
    return { bytesBefore, bytesAfter: this.sizeBytes() }
  }
}

function directorySize(dir) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += directorySize(full)
      else if (entry.isFile()) total += fs.statSync(full).size
    } catch {
      // A file that vanished mid-walk contributes zero.
    }
  }
  return total
}

/** Stable directory-name key for a workspace path. */
export function workspaceKey(cwd) {
  const normalized = path.resolve(String(cwd)).replace(/\\/g, '/').toLowerCase()
  let hash = 0
  // FNV-1a is plenty here: the key only separates directories.
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${sanitize(cwd)}`
}

function sanitize(value) {
  const base = path.basename(String(value).replace(/[\\/]+$/, '')) || 'workspace'
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)
  return cleaned || 'workspace'
}

/** Diagnostics value used by status output. */
export function gitPlatformInfo() {
  return { platform: process.platform, tmpdir: os.tmpdir() }
}
