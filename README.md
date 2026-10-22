# dsh-all-rewind

[![npm version](https://img.shields.io/npm/v/dsh-all-rewind.svg)](https://www.npmjs.com/package/dsh-all-rewind)
[![CI](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[中文说明](README.zh-CN.md)**


TRAE-style **"rewind to before a conversation turn"** for [DeepSeek Harness](https://harness.deepseek.com) (DSH):
every turn is snapshotted before the model starts, every AI tool call commits again, and one click restores the
workspace files to exactly the state they had before that turn.

> Same mechanism as TRAE (hidden per-session snapshot repository, `before-chat-turn` / `toolcall` anchors,
> content-addressed storage, file-level restore) — but with a built-in **content-addressed directory tree**
> backend: structural sharing + deduplication + automatic maintenance, no local `git` binary required.

- Rewind button sits **under each user prompt** (the TRAE placement), not in a floating panel.
- **Reversible**: a `pre-revert` safety snapshot is taken first, so a rollback can itself be rolled back.
- **Bounded disk**: unchanged files are shared across versions; old turns are pruned; a GC runs automatically.
- **Configurable storage**: put snapshots on another drive with one option.

---

## Table of contents

- [Preview](#preview)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [Where snapshots live](#where-snapshots-live)
- [How it works](#how-it-works)
- [Disk usage](#disk-usage)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Publishing (maintainers)](#publishing-maintainers)
- [License](#license)

---

## Preview

Once installed and restarted, every prompt you send gets a small action underneath it:

```text
┌────────────────────────────────────────────────────────────┐
│  You: 把登录页按钮改成蓝色，顺便把 api.ts 里的旧接口删掉      │
└────────────────────────────────────────────────────────────┘
                          ↩ Rewind to before turn 12
```

Hover it to see the file-change count, the prompt preview, and where snapshots are stored.
Click it → confirm → the AI's changes from that turn are undone on disk (a toast reports
restored / removed / skipped files and the safety snapshot version).

---

## Features

| | |
| --- | --- |
| **Turn-level snapshots** | `before-chat-turn-<n>` is written on `turn/start`, before the model touches anything. |
| **Per-tool commits** | every mutating tool result writes `toolcall-<n>-<callId>`, so the snapshot chain is auditable. |
| **File-level restore** | restores modified files, deletes files the turn created, removes nothing that was never tracked. |
| **Safe** | safety snapshot before each rollback; conflict detection for hand-edited files; refuses to roll back when the workspace scan is truncated. |
| **Lightweight** | content-addressed directory trees: unchanged directories/files are shared across versions (measured ~25 MiB → 7.4 MiB on a 2000-file repo). |
| **Maintenance** | `keepTurns` window pruning + automatic GC when the repository exceeds 128 MiB. |
| **Configurable storage** | `dataDir` / `DSH_ALL_REWIND_DIR`, absolute / `~/` / `$DSH_HOME`-relative paths. |
| **Agent-friendly** | host tools `rewind_status`, `rewind_list`, `rewind_restore`, `rewind_prune`, plus a local-only HTTP API. |

---

## Requirements

- DeepSeek Harness with plugin support (desktop app or web profile).
- **Node.js 22+ only for the source/manual installer** (`node install.mjs`).
  Installing through the DSH plugin manager needs no local Node.
- No runtime npm dependencies. Works on Windows / macOS / Linux.

---

## Install

> After installing by any method, **restart DeepSeek Harness** (the desktop shell collects UI injection rows
> and loads plugins at startup).

### A. DSH plugin manager / npm (recommended)

Once published to npm:

- **Web profile** — if your DSH build exposes the CLI:

  ```bash
  dsh plugin --profile web add dsh-all-rewind
  ```

- **Desktop app** — ask the DSH agent to install the plugin bundle `dsh-all-rewind`
  (it uses the plugin manager's `install_bundle` under the hood), or use the Plugins UI.
  Do **not** run `dsh plugin --profile desktop …` in a terminal: the desktop profile is managed by the app.

### B. Straight from GitHub (latest `main`, no npm release needed)

```bash
dsh plugin --profile web add github:ShaoBei47/dsh-all-rewind
```

### C. From the npm package into a profile (manual, no plugin manager)

```bash
# 1) download the package into a temp prefix
npm install --prefix "%TEMP%\dsh-rewind-pkg" dsh-all-rewind

# 2) copy it into the desktop profile and register it in cordis.patch.yml
#    (run inside the cloned repository, needs Node 22+)
node install.mjs --source "%TEMP%\dsh-rewind-pkg\node_modules\dsh-all-rewind"
```

### D. From source (development / offline)

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind

node install.mjs                                  # install into the `desktop` profile
node install.mjs --profile web                    # another profile
node install.mjs --data-dir E:/dsh-rewind-snapshots   # put snapshots on another drive
node install.mjs --dry-run                        # show what would change
node install.mjs --uninstall                      # remove the plugin entry + copied files
```

`install.mjs` copies the runtime package into `<DSH_HOME>/profiles/<profile>/node_modules/dsh-all-rewind`
and appends a managed block to `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`
(a timestamped `cordis.patch.yml.bak-*` backup is created every time). It never touches your snapshot data.

**Manual install (equivalent):** copy this package to
`<DSH_HOME>/profiles/desktop/node_modules/dsh-all-rewind`, then append to
`<DSH_HOME>/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-all-rewind
      name: dsh-all-rewind
      config:
        keepTurns: 20
```

### Verify the installation

- The chat shows a rewind action under your prompts (see [Preview](#preview)).
- The host logs contain `dsh-all-rewind ready (dataDir=…)`.
- Ask the agent for `rewind_status`, or call:

  ```bash
  curl http://127.0.0.1:19387/dsh-all-rewind/api/status
  ```

---

## Usage

### Rewind from the UI

1. Send a prompt and let the AI edit files.
2. A line appears under that prompt: `↩ Rewind to before turn N`
   (new turns show up within ~2.5 s; switching sessions reloads automatically).
3. Hover to check what that turn changed and where snapshots live.
4. Click → confirm. The workspace is restored to the state **before that turn**.
5. Reopen already-open editor tabs to see the restored content.

What exactly happens:

- every file the turn modified is restored from the snapshot;
- every file the turn created is deleted;
- files that no snapshot ever saw (your own edits) are left alone;
- a `pre-revert-<time>` safety snapshot is written first and a `post-revert-<time>` baseline after,
  so the rollback itself is reversible.

### Rewind from the agent (chat tools)

| Tool | What it does |
| --- | --- |
| `rewind_status` | Snapshot repositories, rewind points, storage location and disk usage. |
| `rewind_list` | List rewind points for the current session (`all: true` for every session). |
| `rewind_restore` | Roll the workspace back: `{ target, dryRun?, onConflict?, force? }`. |
| `rewind_prune` | Drop versions outside the configured `keepTurns` window. |

Natural-language examples:

- "list my rewind points"
- "rewind to before turn 3"
- "show me what turn 2 would restore, without changing anything" (→ `dryRun: true`)

`target` accepts a version number (recommended), a commit/tree id prefix, or a label such as
`before-chat-turn-3`.

### HTTP API

The client UI uses this local API; you can script it too. All endpoints are loopback-only
(`localhost` / `127.0.0.0/8` / `::1`), reject cross-site requests, and require
`Content-Type: application/json` for POSTs.

```
GET  /dsh-all-rewind/api/status                 # storage.dataDir, diskBytes, sessions, points
GET  /dsh-all-rewind/api/sessions
GET  /dsh-all-rewind/api/points?sessionId=<id>
POST /dsh-all-rewind/api/revert                 {sessionId, target, dryRun?, onConflict?, force?}
POST /dsh-all-rewind/api/prune                  {sessionId?}
POST /dsh-all-rewind/api/maintenance            {sessionId?, keepVersions?}
GET  /dsh-all-rewind/ui.js
```

Example:

```bash
curl -X POST http://127.0.0.1:19387/dsh-all-rewind/api/revert \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"session-abc","target":12,"dryRun":true}'
```

---

## Configuration

Configuration lives in the plugin entry inside your profile's `cordis.patch.yml`
(the block `install.mjs` manages):

```yaml
- insert:
    - id: dsh-all-rewind
      name: dsh-all-rewind
      config:
        dataDir: "E:/dsh-rewind-snapshots"   # optional, see "Where snapshots live"
        keepTurns: 20
        autoMaintenance:
          enabled: true
          thresholdBytes: 134217728          # 128 MiB
          checkEveryTurns: 3
```

| Option | Default | Description |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/dsh-all-rewind` | Snapshot storage root (absolute, `~/…`, or relative to `$DSH_HOME`). |
| `keepTurns` | `20` | Rewind points kept visible; older tool-call versions are pruned with the same window. |
| `autoMaintenance.enabled` | `true` | Enable the automatic disk safety net. |
| `autoMaintenance.thresholdBytes` | `134217728` | Run a GC once the repository grows past this size. |
| `autoMaintenance.checkEveryTurns` | `3` | How often the (cheap) size check runs. |
| `autoMaintenance.keepVersions` | `200` | Versions kept by an automatic GC. |
| `maxFileBytes` | `1048576` | Files above this size are not versioned. |
| `maxFiles` | `8000` | Scan cap; exceeding it marks the snapshot truncated and **rollback is refused** (never deletes unverified files). |
| `maxTotalBytes` | `268435456` | Scan byte cap. |
| `ignoreDirs` | `.git`, `node_modules`, `dist`, `.tmp`, … | Extra directory names to skip. |
| `ignoreFiles` | `.DS_Store`, … | Extra file names to skip. |
| `captureSkipTools` | read-only tools (`read`, `grep`, `web_*`, …) | Tools that never trigger a snapshot. |
| `respectSandboxPolicy` | `true` | Refuse rollback in read-only sessions (pass `force` to override). |
| `onConflict` | `overwrite` | What to do with files you edited by hand after the snapshot: `overwrite` (safety snapshot exists) or `skip`. |
| `http.enabled` | `true` | Register the local HTTP API / UI asset route. |
| `http.requireLocalOrigin` | `true` | Enforce loopback Host + same-origin + CSRF checks. |
| `ui.enabled` | `true` | Inject the client-side rewind actions. |

---

## Where snapshots live

Resolution order:

1. `config.dataDir` in `cordis.patch.yml`;
2. environment variable `DSH_ALL_REWIND_DIR`;
3. default `$DSH_HOME/dsh-all-rewind` (on Windows usually `C:\Users\<you>\.dsh\dsh-all-rewind`).

Supported forms: absolute path, `~/…`, or a path relative to `$DSH_HOME`.
The absolute location and current usage are visible in the button tooltip and in
`rewind_status` / `GET /api/status` (`storage.dataDir`, `storage.diskBytes`).

Changing `dataDir` does **not** migrate existing snapshots: move/delete the old directory yourself if needed.

Per-session layout (`<dataDir>/snapshots/<sessionId>/v2/`):

```text
objects/<aa>/<rest>          content-addressed blobs & directory tree nodes (zlib, sha256 names)
base/content/<rel>           mirror of the workspace at the latest snapshot
disk/content/<rel>           tombstone copy of deleted files
version_file_<n>.json        one small metadata file per version: root tree id, change set, stats
first_graph.json             repository identity (session id + workspace)
latest_change.json           pointer to the newest version
```

---

## How it works

### Event → snapshot timeline

```text
session/created   → baseline-<time>                    first observation of the workspace
turn/start        → before-chat-turn-<turn>            ← the point "Rewind to before turn N" targets
                    + pruneVersions(keepTurns)
                    + maybe auto-maintenance (size check)
user/message      → attach the prompt preview to that point
tool/call         → remember callId → tool name
tool/result       → toolcall-<turn>-<callId>           (read-only tools are skipped)
rewind            → pre-revert-<time> → restore files → post-revert-<time>
```

### Restore algorithm

Given the target version's tree, the current disk state, and the newest snapshot:

| Situation | Action |
| --- | --- |
| tracked in target, missing on disk | restore from blob |
| tracked in target, same content | no-op |
| tracked in target, different content | overwrite (recorded as `conflict` if you hand-edited it) |
| created after target (in newest snapshot, not in target) | delete |
| never snapshotted (your own new file) | **never touched** |
| workspace scan truncated | refuse to roll back |

### Design notes

- **No `git` dependency.** A hidden per-session repository keeps TRAE's layout and anchor names, but uses a
  small built-in content-addressed object store: blobs are zlib-compressed and named by sha256, directory
  trees are content-addressed JSON (`{"f":{file→blob},"d":{dir→subtree id}}`) so unchanged subtrees are
  shared across versions, exactly like git trees. This works in confined hosts that forbid spawning
  child processes and on machines without git.
- **Rollbacks write files directly** (binary-safe) and keep their own safety snapshots, so a failed or
  unintended rollback can be reverted again.

---

## Disk usage

Measured with the same synthetic workload, before (`v0.1`, full file list per version) and after
(`v0.2+`, shared tree manifests + window pruning):

| Scenario | Workspace | v0.1 snapshot dir | **current snapshot dir** |
| --- | --- | --- | --- |
| 400 files / 30 turns (61 versions) | 1.3 MiB | 6.8 MiB | **1.6 MiB** (metadata 65 KiB) |
| 2000 files / 20 turns (41 versions) | 6.4 MiB | 25.0 MiB | **7.4 MiB** (metadata 104 KiB) |

The remaining fixed cost is the `base/content` mirror (≈ 1× tracked source) plus the content of files that
really changed. Automatic maintenance plus `keepTurns` keeps long sessions bounded.

---

## Limitations

- **Files only, not the conversation.** Rewinding restores the workspace; the chat transcript stays intact
  (same behavior as TRAE's button).
- **Only turns captured while the plugin runs** get a rewind action; old turns from before installation,
  or turns pruned by `keepTurns`, have no action.
- **Shared workspaces:** parallel sessions/subagents editing the same directory keep independent snapshots;
  rolling back one session writes its file state and can overwrite concurrent edits from another.
- **Big files / ignored dirs are not versioned** (`maxFileBytes`, `ignoreDirs`); rollback will not touch them.
- **Read-only sessions** refuse a rollback unless `force: true`.
- Changing `dataDir` does not move old snapshots.

---

## Troubleshooting

**No rewind action appears under my prompts**

1. Did you restart DeepSeek Harness after installing? The plugin and its UI are loaded at startup.
2. Ask the agent for `rewind_status` (or open `/dsh-all-rewind/api/status`). It should report the plugin
   version and the storage path.
3. Open DevTools console and run `__dshAllRewind` — `undefined` means the client script was not injected.
   `__dshAllRewind.state` shows the detected session and rewind points; `__dshAllRewind.reconcile()` re-scans the DOM.
4. If you installed through the DSH plugin manager, confirm the bundle is enabled for the current profile.

**The action is missing on an older prompt**

That turn has no snapshot: the plugin started after it, or the version was pruned by `keepTurns`
(increase it, restart, and new turns keep more history).

**Rollback reports skipped files**

Those files were edited outside the AI turn after the snapshot; the conflict policy is `overwrite` by
default, use `onConflict: "skip"` to always leave hand edits alone. In both cases a safety snapshot was
recorded first.

**Disk usage is high**

Check `rewind_status` (or the tooltip) for the current size; lower `keepTurns`, raise `ignoreDirs` coverage,
or run `POST /api/maintenance` (or `rewind_prune`) to prune and GC.

**I cannot install on desktop with the CLI**

The desktop profile is app-managed; use the agent/plugin UI (method A) or the source/manual installer
(methods C/D). Only the web profile accepts `dsh plugin --profile web add …`.

---

## Development

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind

npm test          # node --test test/  (Node 22+; spawns per-file test processes)
npm run test:all  # all tests in one process (for sandboxes that forbid spawning)
npm run smoke     # end-to-end smoke test without a DSH host
```

| Path | Purpose |
| --- | --- |
| `lib/index.js` | Cordis plugin entry: event listeners, tools, routes, UI injection |
| `lib/manager.js` | session → store mapping, turn tracking, auto maintenance |
| `lib/store.js` | snapshot capture / restore / prune / GC |
| `lib/tree.js` | content-addressed directory trees (structural sharing) |
| `lib/objects.js` | content-addressed blob store (zlib + sha256) |
| `lib/workspace.js` | workspace scan, manifest diff, restore planner |
| `lib/http.js` | local HTTP API with Host/CSRF checks |
| `assets/ui.js` | client-side rewind actions under each prompt |
| `install.mjs` | profile installer / uninstaller / `--source` / `--data-dir` |
| `test/` | unit, integration, client-DOM, installer, loader and smoke tests |

`test/real-cordis.test.js` and `test/loader.test.js` load the plugin with a real Cordis build when one is
available (`DSH_CORDIS_PATH`), and skip otherwise.

---

## Publishing (maintainers)

```bash
npm login
npm publish                 # prepublishOnly runs the tests; publishConfig.access = public

# or release through CI:
git tag v0.3.0 && git push origin v0.3.0   # requires NPM_TOKEN secret in the repository
```

Before publishing a new version: bump `package.json` `version`, update `CHANGELOG.md`, run `npm test`.
`npm pack --dry-run` must list only runtime files (`lib/`, `assets/`, manifests, installer, docs).

If you rename the GitHub account/repository, update `repository` / `homepage` / `bugs` in `package.json`,
the badge URLs and install commands in both READMEs.

---

## License

[MIT](LICENSE)
