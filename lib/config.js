// Resolved plugin configuration. Kept schema-free on purpose: the bundle patch
// in cordis.patch.yml is plain YAML, and a missing/partial config must still
// produce a working plugin.
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_FILES } from './workspace.js'

export const DEFAULT_SKIP_TOOLS = Object.freeze([
  'read', 'grep', 'glob', 'web_search', 'web_fetch', 'read_image', 'todo_write',
  'get_goal', 'list_agents', 'job_list', 'job_output', 'ask_user_question',
  'present', 'skill', 'wait_agent', 'ops_inspect_local_file', 'ops_grep', 'ops_glob',
])

/** Tools that must never trigger a snapshot (the plugin's own surface). */
export const ALWAYS_SKIP_TOOLS = Object.freeze([
  'rewind_status', 'rewind_list', 'rewind_restore', 'rewind_prune',
])

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_FILES = 8000
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
const DEFAULT_AUTO_MAINTAIN_BYTES = 128 * 1024 * 1024

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Default snapshot root when neither config nor env names one. */
export function defaultDataDir() {
  return path.join(dshHome(), 'dsh-all-rewind')
}

/**
 * Resolve the snapshot storage directory:
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
    // How many `before-chat-turn` rewind points stay visible in the UI. Older
    // tool-call versions are pruned with the same window.
    keepTurns: clampInt(config.keepTurns, 1, 500, 20),
    // Files larger than this are not versioned.
    maxFileBytes: clampInt(config.maxFileBytes, 1024, 64 * 1024 * 1024, DEFAULT_MAX_FILE_BYTES),
    maxFiles: clampInt(config.maxFiles, 1, 100_000, DEFAULT_MAX_FILES),
    maxTotalBytes: clampInt(config.maxTotalBytes, 1024 * 1024, 8 * 1024 * 1024 * 1024, DEFAULT_MAX_TOTAL_BYTES),
    ignoreDirs: uniqueStrings([...DEFAULT_IGNORE_DIRS, ...(asArray(config.ignoreDirs))]),
    ignoreFiles: uniqueStrings([...DEFAULT_IGNORE_FILES, ...(asArray(config.ignoreFiles))]),
    captureSkipTools: uniqueStrings([...DEFAULT_SKIP_TOOLS, ...ALWAYS_SKIP_TOOLS, ...(asArray(config.captureSkipTools))]),
    // Refuse a restore in a read-only session unless explicitly forced.
    respectSandboxPolicy: config.respectSandboxPolicy !== false,
    // Conflict default: 'overwrite' matches TRAE (with a rewindable safety
    // snapshot), 'skip' leaves externally modified files alone.
    onConflict: config.onConflict === 'skip' ? 'skip' : 'overwrite',
    autoMaintenance: {
      // Triggered from turn/start after the snapshot is written; the check is
      // cheap (one directory size walk every `checkEveryTurns` turns).
      enabled: config.autoMaintenance?.enabled !== false,
      thresholdBytes: clampInt(
        config.autoMaintenance?.thresholdBytes,
        8 * 1024 * 1024,
        64 * 1024 * 1024 * 1024,
        DEFAULT_AUTO_MAINTAIN_BYTES,
      ),
      checkEveryTurns: clampInt(config.autoMaintenance?.checkEveryTurns, 1, 100, 3),
      keepVersions: clampInt(config.autoMaintenance?.keepVersions, 20, 10_000, 200),
    },
    log: config.log !== false,
    http: {
      enabled: config.http?.enabled !== false,
      requireLocalOrigin: config.http?.requireLocalOrigin !== false,
      bodyLimitBytes: clampInt(config.http?.bodyLimitBytes, 4096, 4 * 1024 * 1024, 1024 * 1024),
    },
    ui: {
      enabled: config.ui?.enabled !== false,
      position: config.ui?.position === 'right' ? 'right' : 'left',
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
