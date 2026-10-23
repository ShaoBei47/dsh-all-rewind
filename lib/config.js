// Resolved plugin configuration. Kept schema-free on purpose: the bundle patch
// in cordis.patch.yml is plain YAML, and a missing/partial config must still
// produce a working plugin.
import os from 'node:os'
import path from 'node:path'

/** Tools the plugin registers itself: never rewind them (they are not snapshotted
 * per tool anymore, this list is kept for tool-name filters in the manager). */
export const ALWAYS_SKIP_TOOLS = Object.freeze([
  'rewind_status', 'rewind_list', 'rewind_restore', 'rewind_prune',
])

/**
 * Heavy directories excluded from every shadow snapshot by default. The
 * workspace's own `.gitignore` is still honoured; this list only protects
 * workspaces that are not git repositories (or whose ignore file is missing).
 */
const DEFAULT_IGNORE_DIRS = Object.freeze([
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  '.gradle/',
  'target/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.tox/',
])

const DEFAULT_IGNORE_FILES = Object.freeze([
  '.DS_Store',
  'Thumbs.db',
])

const DEFAULT_GIT_TIMEOUT_MS = 120_000
const DEFAULT_AUTO_MAINTAIN_BYTES = 512 * 1024 * 1024

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Default snapshot root when neither config nor env names one. */
export function defaultDataDir() {
  return path.join(dshHome(), 'dsh-all-rewind')
}

/**
 * Resolve the shadow-repository root directory:
 *   1. `config.dataDir` (absolute, `~/...`, or relative to DSH_HOME)
 *   2. `DSH_ALL_REWIND_DIR` (legacy `DSH_TRAE_REWIND_DIR` is still accepted)
 *   3. `$DSH_HOME/dsh-all-rewind`
 */
export function resolveDataDir(raw) {
  const configured = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
  const fromEnv = process.env.DSH_ALL_REWIND_DIR?.trim()
    || process.env.DSH_TRAE_REWIND_DIR?.trim() // legacy name, kept for migration
    || undefined
  const value = configured ?? fromEnv
  if (!value) return defaultDataDir()
  let expanded = value
  if (expanded === '~') expanded = os.homedir()
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2))
  }
  // Relative paths are anchored at DSH_HOME so a patch file stays portable.
  if (!path.isAbsolute(expanded)) expanded = path.join(dshHome(), expanded)
  return path.normalize(expanded)
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {object} resolved configuration
 */
export function resolveConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const dataDir = resolveDataDir(config.dataDir)
  return {
    dataDir,
    // Located git executable. Users with a non-PATH git set this to the full path.
    gitExecutable: typeof config.gitExecutable === 'string' && config.gitExecutable.trim()
      ? config.gitExecutable.trim()
      : 'git',
    // Cap for one `git add`/`gc` call; huge workspaces may need more.
    gitTimeoutMs: clampInt(config.gitTimeoutMs, 5_000, 30 * 60_000, DEFAULT_GIT_TIMEOUT_MS),
    // How many per-turn rewind points stay listed per session.
    keepTurns: clampInt(config.keepTurns, 1, 500, 20),
    // Conversation rewind is the headline behaviour: fork the session back to the
    // turn boundary and hide the old session by archiving it.
    // Conversation rewind appends an empty surface replace to the live session;
    // there is no fork or archived copy any more.
    conversation: {
      enabled: config.conversation?.enabled !== false,
    },
    ignoreDirs: uniqueStrings([...DEFAULT_IGNORE_DIRS, ...(asArray(config.ignoreDirs))]),
    ignoreFiles: uniqueStrings([...DEFAULT_IGNORE_FILES, ...(asArray(config.ignoreFiles))]),
    // Raw gitignore-style patterns appended to the shadow repository exclude file.
    extraExcludes: uniqueStrings(asArray(config.exclude)),
    // Refuse a restore in a read-only session unless explicitly forced.
    respectSandboxPolicy: config.respectSandboxPolicy !== false,
    autoMaintenance: {
      // After a turn snapshot: every `checkEveryTurns` turns, run `git gc` when
      // the shadow repository exceeds `thresholdBytes`.
      enabled: config.autoMaintenance?.enabled !== false,
      thresholdBytes: clampInt(
        config.autoMaintenance?.thresholdBytes,
        8 * 1024 * 1024,
        64 * 1024 * 1024 * 1024,
        DEFAULT_AUTO_MAINTAIN_BYTES,
      ),
      checkEveryTurns: clampInt(config.autoMaintenance?.checkEveryTurns, 1, 100, 5),
    },
    log: config.log !== false,
    http: {
      enabled: config.http?.enabled !== false,
      requireLocalOrigin: config.http?.requireLocalOrigin !== false,
      bodyLimitBytes: clampInt(config.http?.bodyLimitBytes, 4096, 4 * 1024 * 1024, 1024 * 1024),
    },
    ui: {
      enabled: config.ui?.enabled !== false,
    },
  }
}

function asArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function uniqueStrings(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}
