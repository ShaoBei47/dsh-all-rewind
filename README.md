# dsh-all-rewind

[![CI](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml/badge.svg)](https://github.com/ShaoBei47/dsh-all-rewind/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-all-rewind.svg)](https://www.npmjs.com/package/dsh-all-rewind)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/DSH-desktop%20%26%20web-4d7cfe)](https://harness.deepseek.com)

**[中文说明](README.zh-CN.md)** · English

TRAE-style **rewind** for [DeepSeek Harness](https://harness.deepseek.com) (DSH).

Every conversation turn gets a snapshot of the workspace **before** the Agent starts working.
A small `↩ Rewind to before turn N` action appears under every user prompt: one click rolls the
workspace files **and** the conversation back to that point - the turn you clicked and everything
after it are no longer visible.

Snapshots live in a **shadow git repository** outside your workspace: one commit per turn, so
unchanged files are stored once and later versions delta-compress. Your own git repository is
never modified (its index, objects, refs and work tree stay exactly as they were).

```text
┌─────────────────────────────────────────────────────────────┐
│  You: change the login button to blue and drop the old API   │
└─────────────────────────────────────────────────────────────┘
                        ↩ Rewind to before turn 12
```

---

## Features

- **Rewind files and conversation together, in place** - restores the workspace to the state
  before the turn and truncates the *same* conversation at that boundary: the turn you rewound and
  everything after it disappear from the transcript and from the model history. No new
  conversation, no fork. The cut reuses DSH's own compaction mechanism (an empty `system/message`
  surface replace); the original prompt is put back into the composer for editing.
- **Small on disk** - a real git object store per workspace (one commit per turn). Only changed
  content is written; `git gc` packs similar file versions into deltas.
- **Does not touch your repository** - the shadow `GIT_DIR` lives under the plugin data directory
  (default `~/.dsh/dsh-all-rewind`), which is configurable.
- **Respects ignore rules** - your `.gitignore` plus a default list of heavy build/dependency
  directories (`node_modules/`, `dist/`, `build/`, `.venv/`, ...) are never snapshotted.
- **Reversible rollback** - the current state is committed as a safety snapshot before files are
  restored, so nothing is lost if you rewind too far.
- **Bounded storage** - only the newest `keepTurns` anchors are listed per session, and `git gc`
  runs automatically once the store grows past a threshold.
- **Works without a git repository** - the shadow repository is created by the plugin, so any
  workspace folder can be snapshotted, not only folders that already are git repositories.
- **Per-workspace storage** - all sessions of one workspace share one repository.

---

## Requirements

### Runtime dependencies

| Requirement | Notes |
| --- | --- |
| DSH desktop app (or `dsh web`) | Tested with DSH 0.2.0-rc.2. Rewind buttons are injected into the chat UI; the host must expose the `sessions`, `sessionQuery` and `sandboxPolicy` services and the `agent/request` event (every interactive web/desktop composition does). |
| **Git 2.13 or newer, resolvable by the DSH process** | The plugin runs `git add`, `git write-tree`, `git read-tree` (plus `git gc` maintenance). A plain Git for Windows / macOS / Linux install is enough - no git account, no remote, no network. On Windows install [Git for Windows](https://git-scm.com/downloads) and **restart DSH** so its process picks up the updated `PATH`. |
| Node.js 22+ | Only for manual source installs and for running the tests; the packaged plugin does not need a separate Node. |
| A writable data directory | Default `$DSH_HOME/dsh-all-rewind` (`C:\Users\<you>\.dsh\dsh-all-rewind`); custom locations are configured with `dataDir`. It must be writable by your user - no administrator rights are needed. |
| Workspace write permission | Rewinds write files into the workspace, so the current workspace must not be read-only for you. |

If `git` is not on `PATH`, point the plugin at it (absolute path, forward slashes):

```yaml
- id: dsh-all-rewind
  config:
    gitExecutable: "C:/Program Files/Git/cmd/git.exe"
```

`rewind_status` (or the button tooltip) reports the git version the plugin found. Git older than 2.13 usually still works but is not supported.

### DSH permission settings

The plugin runs inside the DSH **host process**, not inside the Agent sandbox, so it does not need tool approvals for its own file writes. Two host-side settings still matter:

| Setting | Required value | Why |
| --- | --- | --- |
| **Session permission preset** | Anything that allows **writing inside the workspace** (e.g. the default / `workspace-write`). A **read-only** session is refused with `READ_ONLY_SESSION`. | Restoring a turn rewrites workspace files with `git read-tree`. |
| **Workspace location** | A normal local folder your user owns and can write to. UNC paths, network shares and folders owned by another account work only when git and your user can access them. | The shadow git repository uses the folder as its work tree. |

No DSH-wide permission, developer mode, admin shell or network access is required. The plugin's local HTTP API only listens through DSH's own loopback web server (same origin, loopback `Host` enforced).

### What the plugin reads and writes

- **Reads:** workspace files (respecting `.gitignore` and the exclude list) and the current session's event stream (user prompt text for the rewind labels).
- **Writes:** the shadow git repository under `dataDir`; workspace files on rewind; one empty `system/message` event into the current session log when a deferred conversation cut is applied; a `localStorage` key in the web client for the visual collapse.
- **Never:** your own `.git` directory/index/refs, files outside the workspace, other sessions' logs, the network.

It also neutralises your global/system git config (`GIT_CONFIG_NOSYSTEM`, empty `GIT_CONFIG_GLOBAL`) and git filters such as LFS, so the snapshots are byte-exact and do not depend on local git settings.

---

## Install

### Option 1: plugin manager / npm (recommended)

```bash
dsh plugin --profile desktop add dsh-all-rewind
```

Then restart DeepSeek Harness. The desktop app's plugin manager page can also install it from npm.

### Option 2: this repository

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind
node install.mjs                                # copy into the desktop profile + patch cordis.patch.yml
node install.mjs --data-dir D:/my-rewind-repo   # optional: custom storage location
```

The installer replaces its own managed block (no duplicates) and removes a legacy
`dsh-trae-rewind` entry left by versions <= 0.3.x.

### Option 3: manual

Copy this package into `<DSH_HOME>/profiles/<profile>/node_modules/dsh-all-rewind` and append to
that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-all-rewind
      name: dsh-all-rewind
      config:
        keepTurns: 20
```

Restart DeepSeek Harness afterwards.

### Verify the install

- Hover a rewind action in the chat: the tooltip shows the storage directory and git version.
- Or ask the Agent to call `rewind_status`; a healthy report contains
  `"backend": "shadow-git"` and `"git": { "available": true, ... }`.

### Upgrade / uninstall

```bash
node install.mjs               # re-run after updating the checkout
node install.mjs --uninstall   # remove the profile entry + copied package
```

Snapshot data under `dataDir` is left in place; delete it manually if you no longer need it.

---

## Quick start

1. Open a workspace and send a prompt; let the Agent finish the turn.
2. A `↩ Rewind to before turn N` action appears under your prompt.
3. Click it and confirm:
   - workspace files return to the state before that turn;
   - the transcript collapses from that prompt onwards and the prompt is put back into the
     composer; the model history is truncated on the next message you send.
4. Edit and re-send from the rewound point. A safety snapshot of the files you left behind is kept
   in the shadow repository.

> Rewinding to **the first turn** restores the pre-conversation workspace state and truncates the
> whole conversation; send the prompt again to start over.

---

## How it works

1. **Anchor per turn.** On `turn/start` the plugin records the workspace in the shadow repository:
   `git add --all` into a private index, `git write-tree`, `git commit-tree`, update
   `refs/heads/main`. A `tools/pre-execute` gate makes the first tool of the turn wait for this
   commit, so no file can change before the baseline exists. The commit id and the session-log
   sequence number are stored in that workspace's `state.json`.
2. **Files: hard restore.** A rewind commits the current state as a safety snapshot and then runs
   `git read-tree -u --reset <anchor>` with `--work-tree` pointing at your workspace. Files that
   existed at the anchor are restored, files created after it are removed, ignored files are left
   alone. Your own `.git` is never read or written.
3. **Conversation: in-place surface cut.** DSH only accepts a `system/message` inside an open
   turn/step, so the click stores a *pending cut* (the target turn's `turn/start` sequence). The
   client collapses the messages from that prompt onwards immediately and puts the prompt back in
   the composer. On the next model request the plugin's `agent/request` hook appends one empty
   `system/message` whose `surfaceOp.replace` covers every surface node at/after the cut - the same
   mechanism DSH compaction uses - so both the transcript and the model history lose that content.
4. **Nothing is forked or duplicated.** The session id, title and log stay the same; the undo
   information (file safety commit) remains in the shadow repository.

### Storage layout

```
<dataDir>/
  .git/empty-gitconfig            # keeps the host's global git config out of snapshots
  shadows/
    <workspace-key>/
      repo.git/                   # private git dir: objects, refs, index
      state.json                  # turn anchors (commit + log sequence) and session metadata
```

- `dataDir` defaults to `$DSH_HOME/dsh-all-rewind` (`C:\Users\<you>\.dsh\dsh-all-rewind` on Windows).
- `<workspace-key>` is derived from the absolute workspace path, so every session in that folder
  shares one repository.
- Change the location with `config.dataDir`, the `DSH_ALL_REWIND_DIR` environment variable, or
  `node install.mjs --data-dir <path>` (`config.dataDir` wins). Changing it does **not** move old
  snapshots; move the folder manually to keep history.

### Disk usage

One `git add` per turn plus one commit: unchanged content maps to the same object, and `git gc`
(automatic once the store exceeds `autoMaintenance.thresholdBytes`) repacks changed files so that
successive versions of large files are delta-compressed. A typical project with a few edited files
per turn stays in the low megabytes; the first commit is small because `node_modules/`, `dist/`
and friends are excluded.

---

## Configuration

All fields are optional. Put them under the plugin entry in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-all-rewind
      name: dsh-all-rewind
      config:
        dataDir: D:/dsh-rewind-repo       # storage root (default $DSH_HOME/dsh-all-rewind)
        gitExecutable: git                # git binary (full path if not on PATH)
        gitTimeoutMs: 120000              # cap for one git command
        keepTurns: 20                     # listed rewind points per session
        conversation:
          enabled: true                   # truncate the conversation in place too
        respectSandboxPolicy: true        # refuse file rewinds in read-only sessions
        autoMaintenance:
          enabled: true
          thresholdBytes: 536870912       # run git gc above ~512 MiB
          checkEveryTurns: 5
        ignoreDirs:                       # added to the default heavy-directory list
          - my-large-cache/
        exclude:                          # raw gitignore-style rules
          - "*.dsh-snap"
```

| Field | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/dsh-all-rewind` | Shadow-repository root. Absolute, `~/...`, or relative to `$DSH_HOME`. |
| `gitExecutable` | `git` | Git command to run. |
| `gitTimeoutMs` | `120000` | Timeout for a single git command. |
| `keepTurns` | `20` | Oldest anchors beyond this window are no longer listed. Git objects stay shared. |
| `conversation.enabled` | `true` | Also rewind the conversation. `false` = files-only plugin. |
| `respectSandboxPolicy` | `true` | Refuse file rewinds in a read-only session unless forced. |
| `autoMaintenance.enabled` | `true` | Run `git gc` automatically. |
| `autoMaintenance.thresholdBytes` | `536870912` | Only run automatic gc above this repository size. |
| `autoMaintenance.checkEveryTurns` | `5` | Turn cadence for the size check. |
| `ignoreDirs`, `ignoreFiles`, `exclude` | built-ins | Extra exclude rules for the shadow repository. |
| `http.enabled` | `true` | Local HTTP API used by the injected UI action. |
| `log` | `true` | Log snapshot/git failures to the DSH log. |

---

## Tools

| Tool | Purpose |
| --- | --- |
| `rewind_status` | Git availability, storage location/size, workspaces, sessions, rewind-point count. |
| `rewind_list` | Rewind points for the caller session (or all sessions). |
| `rewind_restore` | Files-only rewind to a turn (or an explicit commit); conversation is untouched. |
| `rewind_prune` | Drop turn anchors beyond `keepTurns`. |

The chat button uses the HTTP API (`POST /dsh-all-rewind/api/rewind`) and rewinds both halves;
tools deliberately touch files only, so an Agent cannot truncate its own conversation.

---

## Migration from 0.4.x

0.4.x stored per-session content-addressed snapshot directories under `<dataDir>/snapshots/`.
0.5.0 replaced that backend with shadow git; both use the same `dataDir` root but different
subdirectories.

1. Install 0.5.0 and restart DeepSeek Harness.
2. Rewind points start with the **next** turn; snapshots recorded by 0.4.x are not converted.
3. `rewind_list`/the UI do not show old points. If you do not need the old data, delete
   `<dataDir>/snapshots` (default `C:\Users\<you>\.dsh\dsh-all-rewind\snapshots`); if you keep it,
   0.5.0 simply ignores it.

---

## Limitations

- **One timeline per workspace.** All sessions of the same workspace share one shadow repository.
  Rewinding session A to an older point also reverts files changed afterwards by session B in the
  same folder. Run parallel work in a separate workspace when that matters.
- **Ignored files are not restored.** Anything matched by `.gitignore` or the plugin exclude list
  (`node_modules`, `dist`, ...) is neither snapshotted nor reverted. That is what keeps the store
  small, but a rewind cannot undo a change inside those directories.
- **The conversation cut is applied on the next model request.** DSH only allows the surface
  node inside an open turn/step, so clicking gives an immediate visual collapse but the permanent
  truncation happens when you send the next message (the reverted prompt is pre-filled). Session
  logs are append-only: the rewind appends events instead of editing history.
- **Ignored files are not restored** (see the storage/ignore rules below).
- **Only completed turns** can be rewound; a running turn has no anchor yet.
- `git lfs` filters are bypassed (`filter.lfs.*` is neutralised) and snapshot content is stored
  byte-for-byte: CRLF/LF conversion is off, file modes are not tracked on Windows, and symlinks are
  recorded as their link text on Windows.
- If a workspace is too large for `gitTimeoutMs`, that turn simply records no anchor (logged);
  other turns keep working.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No rewind actions appear | Make sure the profile entry is present, git is installed (`rewind_status`), and restart DeepSeek Harness. Points only exist for turns that started after the plugin loaded. |
| `CONVERSATION_UNAVAILABLE` | The host does not expose `sessionController`/`workspaceRegistry` (e.g. a headless composition). Set `conversation.enabled: false` to use files-only rewind. |
| `READ_ONLY_SESSION` | The session runs with a read-only permission preset; switch to a preset that can write the workspace, or pass `force` to the tool. |
| `NO_POINT` | No anchor for that turn - it may predate the plugin, exceed `gitTimeoutMs`, or already be pruned by `keepTurns`. |
| `GIT_UNAVAILABLE` / no actions at all | `git` is not on the DSH process's `PATH`: install Git, restart DSH, or set `gitExecutable` to the absolute path. `rewind_status` shows the detected executable/version. |
| git errors such as `index.lock`, `Permission denied`, `Access is denied` | The workspace or data directory is locked/not writable for your user (antivirus, another process, admin-owned folder). Close the locking program, fix permissions, or point `dataDir` at a writable folder. |
| Very slow first turn | The first snapshot writes the whole workspace (minus ignored paths). Exclude large build/dependency folders with `ignoreDirs`/`exclude`; the next snapshots are incremental. |
| Disk keeps growing | Lower `autoMaintenance.thresholdBytes`, run `rewind_prune`, and confirm `node_modules`/build output are excluded. |
| Button clicked but nothing changes | Check the DSH log for `dsh-all-rewind` messages; a git failure logs the command and its stderr. |

---

## Contributing

Development setup, test matrix and release steps live in [CONTRIBUTING.md](CONTRIBUTING.md).
Bug reports are welcome at <https://github.com/ShaoBei47/dsh-all-rewind/issues>.

## License

[MIT](LICENSE)
