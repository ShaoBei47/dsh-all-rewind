# Changelog

All notable changes to `dsh-all-rewind` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
