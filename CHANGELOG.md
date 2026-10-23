# Changelog

All notable changes to `dsh-all-rewind` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-10

### Changed

- **Conversation rewind is now in place.** 0.5.x forked the session at the turn boundary and
  re-opened the child, which is not the TRAE behaviour (it looked like a new conversation).
  0.6.0 truncates the *same* conversation using the mechanism DSH's own compaction uses: append
  one empty `system/message` whose `surfaceOp.replace` covers every surface node from the target
  turn's `turn/start` onwards. The transcript and the model history both lose that content; the
  session id, title and log stay the same.
- DSH only accepts a `system/message` inside an open turn/step, so the click stores a **deferred
  cut** (`<dataDir>/shadows/<workspace>/state.json`, plus an in-memory map) and the plugin's new
  `agent/request` waterfall applies it right before the next model request is derived.
- The client now collapses the messages from the clicked prompt onwards immediately, puts the
  original prompt back into the composer, and persists the visual cut in
  `localStorage: dsh-all-rewind:cut:<sessionId>` so it survives a reload until the host applies it.
- Rewind points at/after the cut are pruned; the API reports `conversation: { deferred: true,
  mode: 'surface-replace', turn, cutAtSeq }` and `GET /api/points` exposes `pendingCut`.
- Removed the fork/child-session machinery (self-fork via `agents.create`) and the
  `POST /api/archive` route; `conversation.archiveOriginal` config is gone.
- `rewind_restore` remains files-only; the per-prompt button rewinds files and conversation.

## [0.5.2] - 2026-10

### Fixed

- **Desktop builds could not rewind the conversation at all.** Diagnostics showed the
  desktop/web composition isolates the API-controller services from ordinary plugins:
  `sessionController` and `workspaceRegistry` resolve to `undefined`, so 0.5.1 silently
  fell back to a files-only rewind. The plugin now builds the fork itself when those
  services are invisible: it reads the source log through the visible `sessionQuery`
  service, cuts it at the last completed `turn/end`, and publishes a seeded session via
  the visible `agents.create({ seed, inheritedEventCount, meta }) ` API (the same call
  DSH's own `session.fork` uses internally). `sessionController.fork` is still preferred
  when available.
- The client switches to the forked session on every composition; the original session
  cannot be auto-archived when the workspace registry is isolated (it stays in the
  sidebar until manually archived).

## [0.5.1] - 2026-10

### Fixed

- **Conversation rewind could not fork.** 0.5.0 cut the session log at
  `turn/start seq - 1`, which can be an internal event (e.g. `agent/inbox/spliced`).
  The cut is now recomputed from the real session log as the last completed
  `turn/end` before the target turn (`sessionQuery.readSession` / `sessionController.inspect`),
  so the fork seed is a clean completed prefix.
- The conversation fork now runs **before** the file restore: a host refusal no
  longer leaves a half-applied rewind (files rolled back, conversation untouched).
- Diagnostics: the plugin writes `<dataDir>/diagnostics.json` with the resolved
  host capabilities, index-injection/UI-serving facts and the exact error of the
  last rewind/fork, so a host-composition problem can be inspected without
  DevTools.
- The injected client script is cache-busted (`ui.js?v=<version>`) so an
  upgraded plugin never runs a stale client action from the browser cache.

## [0.5.0] - 2026-10

### Changed

- **Storage engine rewritten as a shadow git repository.** Each workspace gets one private
  `GIT_DIR` (under `<dataDir>/shadows/<workspace-key>/repo.git`) and one commit per conversation
  turn. Files are stored as git objects, so unchanged content is written once and `git gc`
  delta-compresses successive versions of large files. The previous per-session
  content-addressed tree store (`lib/store.js`, `lib/tree.js`, `lib/objects.js`, `lib/workspace.js`)
  is removed; `<dataDir>/snapshots` from 0.4.x is ignored and can be deleted.
- **Conversation rewind is now part of the feature.** Rewinding to a turn forks the session log at
  the event sequence recorded just before that turn (`session.fork`), archives the original session,
  and re-opens the forked session in the client. Files and conversation roll back together; a turn
  and everything after it disappear from the chat. `conversation.enabled: false` restores the old
  files-only behavior.
- The rewind button now uses `POST /dsh-all-rewind/api/rewind`; `api/revert` remains as an alias.
  Success responses include `files` (restored/removed/safety commit) and `conversation`
  (forked session id, `shouldArchive` flag). The original session is archived by the reloaded
  client (a new `POST /api/archive` route) because archiving before the reload would make the live
  client clear its persisted session selection.
- `rewind_restore` intentionally rewinds **files only**, so an Agent cannot fork/archive its own session.
- Rewind points are matched by conversation turn only (no per-tool-call anchors anymore).
- Configuration: `maxFileBytes`, `maxFiles`, `maxTotalBytes`, `onConflict` and `captureSkipTools`
  were removed (git has no per-file cap; restore always recreates the exact anchored tree). New / changed:
  `gitExecutable`, `gitTimeoutMs`, `conversation.{enabled,archiveOriginal}`, `ignoreDirs`,
  `ignoreFiles`, `exclude`, `autoMaintenance.thresholdBytes` (default 512 MiB) and
  `autoMaintenance.checkEveryTurns` (default 5).
- Requirements now include **Git 2.13+ on `PATH`** (or `config.gitExecutable`). `install.mjs` reports
  the detected git version and warns when git is missing.
- `rewind_status` reports `backend: "shadow-git"`, git availability/version, storage location/size,
  workspaces and point counts.

### Migration

1. Install 0.5.0 (same `dataDir` is fine) and restart DeepSeek Harness.
2. Rewind points start with the next turn; 0.4.x snapshots are not converted.
3. Delete `<dataDir>/snapshots` if you do not need the old data (0.5.0 ignores it).
4. Make sure `git` is available to DSH; otherwise set `gitExecutable` in the plugin config.

## [0.4.0] - 2026-08

### Changed

- **Renamed** the project from `dsh-trae-rewind` to **`dsh-all-rewind`**: npm package name, GitHub repository,
  Cordis plugin id/name, client global (`__dshAllRewind`), CSS class prefix (`dar-`), HTTP API prefix
  (`/dsh-all-rewind/...`) and the default snapshot root (`$DSH_HOME/dsh-all-rewind`).
- `DSH_ALL_REWIND_DIR` is the storage environment variable; the legacy `DSH_TRAE_REWIND_DIR` is still accepted.
- `install.mjs` removes a legacy `# >>> dsh-trae-rewind` patch block and legacy `node_modules/dsh-trae-rewind`
  directory on install/uninstall, and carries over a legacy `dataDir` value.

### Migration

1. Uninstall the previous plugin (run `node install.mjs --uninstall` from the old checkout) or let the new
   installer clean the legacy entry automatically.
2. Install this version and pass `--data-dir <old path>` if you had a custom snapshot location.
3. Restart DeepSeek Harness; snapshot data on disk does not need to be migrated.

## [0.3.0] - 2026-08

### Changed

- Rewind entry moved from a floating panel to a small action **under every user
  prompt bubble** (`↩ 回退到第 N 轮对话之前`), matching the TRAE placement.
- The client finds prompts through stable chat DOM attributes
  (`[data-conversation-session]`, `[data-chat-flow-kind="user"][data-chat-turn]`)
  and re-attaches after React re-renders via a `MutationObserver`.
- Revert results are shown as a bottom toast (restored / removed / skipped files,
  safety snapshot version); storage location & usage moved into the action tooltip.

## [0.2.0] - 2026-08

### Added

- Content-addressed **directory trees** (`lib/tree.js`): unchanged directories and
  files are shared across versions, so per-version metadata is O(changed paths)
  instead of O(all files). Measured 2000-file / 20-turn workload: 25.0 MiB → 7.4 MiB
  snapshot directory, metadata 17.9 MiB → 104 KiB.
- Configurable snapshot storage location: `config.dataDir` > `DSH_ALL_REWIND_DIR`
  > `$DSH_HOME/dsh-all-rewind`, with `~` and DSH_HOME-relative path support.
- Automatic maintenance: every `checkEveryTurns` turns, once the repository exceeds
  `thresholdBytes` (default 128 MiB) a GC runs; `pruneVersions()` bounds versions to
  the `keepTurns` window.
- `install.mjs --data-dir <path>` and preservation of an existing `dataDir` on reinstall.

### Changed

- `version_file_<n>.json` stores only a root tree id + change set (no full manifest).
- Maintenance/GC walks tree references; legacy full-manifest snapshot files remain readable.

## [0.1.0] - 2026-08

### Added

- Per-session hidden snapshot repository under `$DSH_HOME/dsh-all-rewind/snapshots/<session>/v2`
  with the TRAE v2 layout: `objects/` (content-addressed blobs), `base/content`
  mirror, `disk/content` tombstones, `version_file_*.json`, `first_graph.json`,
  `latest_change.json`.
- Turn anchors: `before-chat-turn-<turn>` on `turn/start`, `toolcall-<turn>-<callId>`
  on tool results, `baseline`, and `pre/post-revert` safety snapshots.
- File-level rollback: three-way plan (restore / delete / skip), untracked-file
  protection, conflict policy, dry-run support, truncation guard.
- Host tools `rewind_status`, `rewind_list`, `rewind_restore`, `rewind_prune`;
  local HTTP API with loopback Host / CSRF checks; `install.mjs` profile installer.
