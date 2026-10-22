# dsh-all-rewind

[![CI](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/DSH-desktop%20%26%20web-4d7cfe)](https://harness.deepseek.com)

**[中文说明](README.zh-CN.md)** · English

A **conversation-turn rewind** plugin for [DeepSeek Harness](https://harness.deepseek.com) (DSH).
Every turn is snapshotted before the model starts, every AI file edit commits again, and **one click under a prompt
restores the workspace to the state it had before that turn**.

```text
┌─────────────────────────────────────────────────────────────┐
│  You: change the login button to blue and drop the old API   │
└─────────────────────────────────────────────────────────────┘
                        ↩ Rewind to before turn 12
```

- **Where you expect it** — the button lives under *your* prompts, exactly like TRAE.
- **Reversible** — a safety snapshot is taken before every rollback, so a rollback can itself be rolled back.
- **Bounded disk** — unchanged files are shared across versions; old turns are pruned; GC runs automatically.
- **Storage on any drive** — point `dataDir` somewhere else with a single option.

---

## Table of contents

- [Preview](#preview)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
  - [Quick install (GitHub)](#quick-install-github)
  - [Install from npm](#install-from-npm)
  - [Manual install (npm package → profile)](#manual-install-npm-package--profile)
  - [Install from source](#install-from-source)
  - [Verify the installation](#verify-the-installation)
  - [Upgrade / uninstall](#upgrade--uninstall)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Where snapshots live](#where-snapshots-live)
- [How it works](#how-it-works)
- [Disk usage](#disk-usage)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Preview

After installing and restarting DSH, every prompt you send gets a small action underneath it:

```text
┌─────────────────────────────────────────────────────────────┐
│  You: change the login button to blue and drop the old API   │
└─────────────────────────────────────────────────────────────┘
                        ↩ Rewind to before turn 12
```

Hover it to see how many files that turn changed, a preview of the prompt, and where snapshots are stored.
Click it → confirm → the AI's file changes from that turn are undone on disk, and a toast reports what was
restored / removed / skipped plus the safety snapshot version.

---

## Features

| | |
| --- | --- |
| **Turn-level snapshots** | `before-chat-turn-<n>` is written on `turn/start`, before the model touches a file. |
| **Per-tool commits** | every mutating tool result writes `toolcall-<n>-<callId>`, so history is auditable. |
| **File-level restore** | restores modified files, removes files the turn created, and never touches files no snapshot has seen. |
| **Safe** | safety snapshot before each rollback, conflict detection for hand-edited files, rollback refuses to run on truncated scans. |
| **Lightweight** | content-addressed directory trees share unchanged files/directories across versions. |
| **Maintenance** | `keepTurns` window pruning plus an automatic GC above a size threshold. |
| **Configurable storage** | `dataDir` / `DSH_ALL_REWIND_DIR`, absolute, `~/…` or `$DSH_HOME`-relative. |
| **Scriptable** | agent tools (`rewind_status`, `rewind_list`, `rewind_restore`, `rewind_prune`) and a loopback-only HTTP API. |

---

## Requirements

- DeepSeek Harness with plugin support (desktop app or a web profile).
- **Node.js 22+** only for the manual/source installer; installing through the DSH plugin manager needs no local Node.
- No runtime npm dependencies. Windows, macOS and Linux are supported.

---

## Install

> After installing by any method, **restart DeepSeek Harness** — the desktop shell loads plugins and injects
> the client UI at startup.

### Quick install (GitHub)

Works today, no npm release required:

```bash
dsh plugin --profile web add github:ShaoBei47/dsh-all-rewind
```

On the **desktop app**, ask the DSH agent to install the plugin bundle `dsh-all-rewind`
(it uses the plugin manager's `install_bundle`), or use the plugin manager UI.
Do **not** run `dsh plugin --profile desktop …` in a terminal: the desktop profile is managed by the app.

### Install from npm

Once the package is published on npm:

```bash
dsh plugin --profile web add dsh-all-rewind
```

Desktop app: same as above — install it through the DSH agent / plugin UI, not a terminal.

### Manual install (npm package → profile)

If you prefer not to use the plugin manager, download the npm package and let the bundled installer copy it
into the profile:

```bash
# 1) download the package into a temporary prefix
npm install --prefix "%TEMP%\dsh-rewind-pkg" dsh-all-rewind

# 2) copy it into the desktop profile and register it in cordis.patch.yml
#    (run from a checkout of this repository; requires Node 22+)
node install.mjs --source "%TEMP%\dsh-rewind-pkg\node_modules\dsh-all-rewind"
```

### Install from source

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind

node install.mjs                                        # desktop profile
node install.mjs --profile web                          # another profile
node install.mjs --data-dir E:/dsh-rewind-snapshots     # snapshots on another drive
node install.mjs --dry-run                              # preview only
```

`install.mjs` copies the runtime package into `<DSH_HOME>/profiles/<profile>/node_modules/dsh-all-rewind`
and appends a managed block to `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` (with a timestamped backup).
It never touches your snapshot data, and it cleans up a legacy `dsh-trae-rewind` entry if one exists.

**Manual equivalent:** copy this package into
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

- A rewind action appears under your prompts;
- the host log contains `dsh-all-rewind ready (dataDir=…)`;
- ask the agent for `rewind_status`, or open:

  ```bash
  curl http://127.0.0.1:19387/dsh-all-rewind/api/status
  ```

### Upgrade / uninstall

```bash
# reinstall / upgrade from a newer checkout
node install.mjs

# uninstall: removes the profile entry + copied package (snapshot data stays)
node install.mjs --uninstall
```

After uninstalling, restart DeepSeek Harness.

---

## Quick start

1. **Install & restart** (see above).
2. Send a prompt that makes the AI edit files.
3. A `↩ Rewind to before turn N` action appears under that prompt within a couple of seconds.
4. Hover to inspect, click to roll back, confirm.

That's it. Already-open editor tabs should be reopened to see the restored content.

---

## Usage

### Rewind from a prompt

- The action appears **only for turns that have a snapshot** (captured while the plugin was running and still
  inside the `keepTurns` window).
- Click → confirmation dialog → the workspace is restored to the state **before that turn**.
- A `pre-revert-<time>` safety snapshot is written first and a `post-revert-<time>` baseline afterwards, so the
  rollback itself is reversible.
- What happens to files:

  | Situation | Action |
  | --- | --- |
  | modified during the turn | restored from the snapshot |
  | created during the turn | deleted |
  | hand-edited outside the turn | overwritten by default (reported as a conflict) or skipped with `onConflict: "skip"` |
  | never seen by any snapshot | **left untouched** |

### Rewind from the agent

| Tool | What it does |
| --- | --- |
| `rewind_status` | Snapshot repositories, rewind points, storage location and disk usage. |
| `rewind_list` | Rewind points for the current session (`all: true` for every session). |
| `rewind_restore` | Roll back the workspace: `{ target, dryRun?, onConflict?, force? }`. |
| `rewind_prune` | Drop versions outside the `keepTurns` window. |

Try saying:

- "list my rewind points"
- "rewind to before turn 3"
- "show me what turn 2 would restore, without changing anything" (uses `dryRun: true`)

`target` accepts a version number (recommended), a commit/tree id prefix, or a label such as `before-chat-turn-3`.

### HTTP API

Used by the client UI; also handy for scripts. Endpoints are loopback-only, reject cross-site requests and
require `Content-Type: application/json` for POSTs.

```
GET  /dsh-all-rewind/api/status            # storage.dataDir, diskBytes, session/point counts
GET  /dsh-all-rewind/api/sessions
GET  /dsh-all-rewind/api/points?sessionId=<id>
POST /dsh-all-rewind/api/revert            {sessionId, target, dryRun?, onConflict?, force?}
POST /dsh-all-rewind/api/prune             {sessionId?}
POST /dsh-all-rewind/api/maintenance       {sessionId?, keepVersions?}
GET  /dsh-all-rewind/ui.js
```

```bash
curl -X POST http://127.0.0.1:19387/dsh-all-rewind/api/revert \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"session-abc","target":12,"dryRun":true}'
```

---

## Configuration

Configuration lives in the plugin entry of your profile's `cordis.patch.yml` (the block `install.mjs` manages):

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
| `dataDir` | `$DSH_HOME/dsh-all-rewind` | Snapshot root (absolute, `~/…`, or relative to `$DSH_HOME`). |
| `keepTurns` | `20` | Rewind points kept visible; older tool-call versions are pruned with the same window. |
| `autoMaintenance.enabled` | `true` | Enable the automatic disk safety net. |
| `autoMaintenance.thresholdBytes` | `134217728` | GC once a repository grows past this size. |
| `autoMaintenance.checkEveryTurns` | `3` | How often the cheap size check runs. |
| `autoMaintenance.keepVersions` | `200` | Versions kept by an automatic GC. |
| `maxFileBytes` | `1048576` | Files above this size are not versioned. |
| `maxFiles` | `8000` | Scan cap. Exceeding it marks the snapshot truncated and **rollback is refused** (never deletes unverified files). |
| `maxTotalBytes` | `268435456` | Scan byte cap. |
| `ignoreDirs` | `.git`, `node_modules`, `dist`, `.tmp`, … | Extra directory names to skip. |
| `ignoreFiles` | `.DS_Store`, … | Extra file names to skip. |
| `captureSkipTools` | read-only tools (`read`, `grep`, `web_*`, …) | Tools that never trigger a snapshot. |
| `respectSandboxPolicy` | `true` | Refuse rollback in read-only sessions (pass `force` to override). |
| `onConflict` | `overwrite` | Conflict policy for files edited by hand after the snapshot: `overwrite` or `skip`. |
| `http.enabled` | `true` | Register the local HTTP API / UI asset route. |
| `http.requireLocalOrigin` | `true` | Enforce loopback Host, same-origin and CSRF checks. |
| `ui.enabled` | `true` | Inject the client-side rewind actions. |

---

## Where snapshots live

Resolution order:

1. `config.dataDir` in `cordis.patch.yml`;
2. environment variable `DSH_ALL_REWIND_DIR` (legacy `DSH_TRAE_REWIND_DIR` is still accepted);
3. default `$DSH_HOME/dsh-all-rewind` (on Windows usually `C:\Users\<you>\.dsh\dsh-all-rewind`).

Supported forms: absolute path, `~/…`, or a path relative to `$DSH_HOME`.
The active location and usage are shown in the action tooltip and in
`rewind_status` / `GET /api/status` (`storage.dataDir`, `storage.diskBytes`).

Changing `dataDir` does **not** migrate existing snapshots; move or delete the old directory yourself.
Per-session layout (`<dataDir>/snapshots/<sessionId>/v2/`):

```text
objects/<aa>/<rest>      content-addressed blobs and directory tree nodes (zlib, sha256 names)
base/content/<rel>       mirror of the workspace at the latest snapshot
disk/content/<rel>       tombstone copy of deleted files
version_file_<n>.json    one small metadata file per version: root tree id, change set, stats
first_graph.json         repository identity (session id + workspace)
latest_change.json       pointer to the newest version
```

---

## How it works

```text
session/created   → baseline-<time>                 first observation of the workspace
turn/start        → before-chat-turn-<turn>         ← the point "Rewind to before turn N" targets
                    + prune versions outside keepTurns
                    + maybe run auto maintenance
user/message      → attach the prompt preview to that point
tool/call         → remember callId → tool name
tool/result       → toolcall-<turn>-<callId>        (read-only tools are skipped)
rewind            → pre-revert-<time> → restore files → post-revert-<time>
```

A hidden per-session repository keeps TRAE's layout and anchor names but uses a small built-in
content-addressed store instead of shelling out to `git`: blobs are zlib-compressed and named by sha256, and
directory trees are content-addressed JSON (`{"f":{file→blob},"d":{dir→subtree id}}`) so unchanged subtrees are
shared across versions — the same structural sharing git trees provide. This keeps the plugin working on
machines without git and in hosts that forbid spawning subprocesses.

Restore compares the target tree, the current disk state and the newest snapshot:

| Situation | Action |
| --- | --- |
| tracked in target, missing on disk | restore from blob |
| tracked in target, same content | skip |
| tracked in target, different content | overwrite (recorded as `conflict` if hand-edited) |
| created after the target | delete |
| never snapshotted | never touched |
| truncated scan | refuse the rollback |

---

## Disk usage

Measured with the same synthetic workload, before (`v0.1`, full file list per version) and after
(`v0.2+`, shared tree manifests + window pruning):

| Scenario | Workspace | v0.1 snapshot dir | **current snapshot dir** |
| --- | --- | --- | --- |
| 400 files / 30 turns (61 versions) | 1.3 MiB | 6.8 MiB | **1.6 MiB** (metadata 65 KiB) |
| 2000 files / 20 turns (41 versions) | 6.4 MiB | 25.0 MiB | **7.4 MiB** (metadata 104 KiB) |

The fixed costs are the `base/content` mirror (≈ 1× tracked source) plus the content of files that really
changed. `keepTurns`, the ignore rules and automatic maintenance keep long sessions bounded.

---

## Limitations

- **Files only, not the conversation.** Rewinding restores the workspace; the transcript stays intact
  (same behavior as TRAE's button).
- **Only captured turns** get an action: turns before installation, or pruned by `keepTurns`, have none.
- **Shared workspaces:** parallel sessions/subagents editing one directory keep independent snapshots; rewinding
  one session writes its file state and can overwrite concurrent edits from another.
- **Large files and ignored directories are not versioned** (`maxFileBytes`, `ignoreDirs`).
- **Read-only sessions** refuse a rollback unless `force: true`.
- Changing `dataDir` does not move old snapshots.

---

## Troubleshooting

**No rewind action appears**

1. Did you restart DeepSeek Harness after installing? Plugins and the client UI load at startup.
2. Ask the agent for `rewind_status` (or open `/dsh-all-rewind/api/status`) and confirm the plugin version
   and storage path.
3. Open DevTools console and run `__dshAllRewind` — `undefined` means the client script was not injected.
   `__dshAllRewind.state` shows the detected session/points; `__dshAllRewind.reconcile()` re-scans the DOM.
4. When installed through the plugin manager, confirm the bundle is enabled for the current profile.

**An older prompt has no action**

That turn has no snapshot: the plugin started after it, or the version was pruned by `keepTurns`.
Increase `keepTurns`, restart, and future turns keep more history.

**Rollback reports skipped files**

Those files were edited outside the AI turn after the snapshot. The default policy overwrites them (a safety
snapshot exists); set `onConflict: "skip"` to always keep hand edits.

**Disk usage is high**

Check the size in `rewind_status` or the tooltip; lower `keepTurns`, extend `ignoreDirs`, or run
`POST /api/maintenance` (or `rewind_prune`) to prune and GC.

**The CLI cannot install for the desktop app**

The desktop profile is app-managed. Install through the agent/plugin UI, or use the manual/source installer.
Only the web profile accepts `dsh plugin --profile web add …`.

---

## Contributing

Bug reports, feature ideas and pull requests are welcome — open an issue first for larger changes.

- Development setup, test commands, project layout and the release checklist live in
  [CONTRIBUTING.md](CONTRIBUTING.md).
- Quick check before a PR:

  ```bash
  npm test          # node --test test/  (Node 22+)
  npm run smoke     # end-to-end smoke test
  ```

---

## License

[MIT](LICENSE)
