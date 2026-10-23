# Contributing to dsh-all-rewind

Thanks for taking the time to improve the project. This document is for contributors and maintainers;
if you only want to install and use the plugin, read [README.md](README.md) (or the
[Chinese README](README.zh-CN.md)).

---

## Ways to contribute

- **Bug reports** — include the DSH version, plugin version (`rewind_status`), platform, the git
  version the plugin found, the turn involved, and the exact result (restored/removed files,
  warnings, console errors).
- **Feature requests** — describe the workflow you want, not only the implementation.
- **Pull requests** — keep changes focused; open an issue first for larger features or refactors.

For anything related to unsafe file or conversation behavior (deleting user files, path traversal,
forking/archiving sessions unexpectedly), please report privately to the maintainer instead of
opening a public issue.

---

## Development setup

Requirements:

- Node.js **22 or newer** (the project is ESM-only);
- **Git 2.13+ on `PATH`** — the test suite runs real `git` against throwaway workspaces;
- no package-manager install step: **zero runtime dependencies, no build step**.

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind
node --version          # >= 22
git --version           # >= 2.13
```

### Test commands

```bash
npm test          # node --test "test/*.test.js"  (one child process per test file)
npm run test:all  # every test file inside one process (sandboxes that forbid spawning)
npm run smoke     # end-to-end smoke test without a DSH host
```

`test/real-cordis.test.js` and `test/loader.test.js` boot the plugin with a real Cordis runtime when
one is reachable and skip otherwise. Point them at an extracted DSH runtime with:

```powershell
# Windows PowerShell
$env:DSH_CORDIS_PATH = "C:\path\to\dsh\node_modules\@deepseek-ai\cordis\lib\index.js"
npm run test:all
```

The two tests also look for an extraction under `.tmp/asar/dsh/node_modules/...` (that path is
gitignored). An easy way to produce it is to unpack the desktop app's `app.asar` (the asar header
stores per-file offsets; a 20-line script is enough) and copy at least:

```
dsh/node_modules/@deepseek-ai/{cordis,cordis-plugin-loader,cordis-plugin-group,cordis-plugin-include,cordis-plugin-timer,cosmokit,schemastery}
dsh/node_modules/@standard-schema/spec
```

### Linting / formatting

There is no linter or formatter configured on purpose (the plugin must stay dependency-free and easy
to audit). Match the surrounding style: ESM, two-space indentation, no semicolons, single quotes,
English code comments.

---

## Project layout

| Path | Purpose |
| --- | --- |
| `lib/index.js` | Cordis plugin entry: event listeners, tool-dispatch gate, tools, routes, UI injection |
| `lib/manager.js` | Session events → turn anchors; rewind orchestration (file restore + deferred in-place conversation cut) |
| `lib/shadow.js` | Per-workspace shadow store: repo + `state.json`, capture, restore, gc, status |
| `lib/git.js` | Git runner and `ShadowRepository` (`init`, `add`/`commit-tree`, `read-tree`, `gc`) |
| `lib/config.js` | Config resolution (`dataDir`, git, conversation, maintenance, excludes) |
| `lib/http.js` | Local HTTP API with Host/CSRF checks |
| `lib/util.js` | Small dependency-free helpers (atomic JSON writes, queues, previews) |
| `assets/ui.js` | Client-side rewind actions under each prompt |
| `install.mjs` | Profile installer/uninstaller (`--source`, `--data-dir`, legacy migration, git check) |
| `test/` | Unit, git, manager, HTTP, client-DOM, installer, loader and smoke tests |

### Design constraints to keep

1. **No runtime dependencies, no build step.** The plugin is copied into a DSH profile as plain ESM files.
2. **Git is the storage engine.** Snapshots are ordinary git objects in a private `GIT_DIR`; never write
   to the user's own `.git` (index, objects, refs, work tree).
3. **Snapshot before the first mutation.** The `tools/pre-execute` gate must keep waiting for the
   current turn's anchor; a snapshot that races a tool call silently loses rollback fidelity.
4. **Ignore rules are part of the contract.** Excluded paths are never snapshotted *and never restored*;
   do not turn an ignore list into a "best effort" walk.
5. **Conversation rewind is an in-place surface replace.** DSH session logs are append-only: never
   edit a session log file. Append one empty `system/message` with `surfaceOp.replace` inside an open
   turn/step (`agent/request`), exactly like DSH compaction; never fork a new session.
6. **Always keep a safety snapshot** before restoring files, so a rewind is reversible.
7. **Treat the local HTTP API as hostile input.** Keep the loopback Host, same-origin and CSRF checks,
   and never accept arbitrary filesystem paths from requests.
8. **Snapshot data is user data.** Never rewrite or delete a repository/state file without an explicit
   user-triggered maintenance action.

---

## Test matrix

| File | Covers |
| --- | --- |
| `test/git.test.js` | Git detection, `ShadowRepository` init/snapshot/restore, ignore handling, nested user repo untouched, gc, workspace keys |
| `test/manager.test.js` | turn/start anchors, previews, file restore, deferred surface cuts (ranges + head protection + restart), refusals, safety undo, pruning |
| `test/plugin.test.js` | Tools/routes/UI injection, full turn flow, HTTP rewind, conversation hand-off, Host/CSRF rejection, bad workspace |
| `test/ui.test.js` | Real `assets/ui.js` in a DOM stub: per-prompt actions, payload, localStorage hand-off + reload, re-attach, session switch, polling |
| `test/config.test.js` | Storage precedence, git/conversation/maintenance defaults, clamping |
| `test/install.test.js` | Installer/uninstaller, `--data-dir`, `--source`, legacy `dsh-trae-rewind` migration |
| `test/real-cordis.test.js` | Plugin loads and anchors a turn inside a real Cordis context (auto-skip) |
| `test/loader.test.js` | Real Cordis loader imports the package from a profile by name (auto-skip) |
| `test/smoke.mjs` | Full turn flow → tool rollback → HTTP rewind (files + conversation) → maintenance |

A PR should keep `npm test` (or `npm run test:all`) and `npm run smoke` green, and add a test for
behavior changes.

---

## Release checklist (maintainers)

1. Update `CHANGELOG.md` (new version, date, notable changes, migration notes).
2. Bump `version` in `package.json`, `dsh-plugin.json`, and the `version` constants in
   `lib/index.js` / `lib/shadow.js`.
3. Run the full checks:

   ```bash
   npm run test:all
   npm run smoke
   npm pack --dry-run   # must contain only runtime files (no tests/.tmp)
   ```

4. Commit, tag and publish:

   ```bash
   git tag v0.5.0
   git push origin main --tags
   npm login
   npm publish --access public   # local publish; provenance is added by the CI workflow
   ```

5. `.github/workflows/publish.yml` runs the tests and publishes when a `v*` tag is pushed. It expects
   an `NPM_TOKEN` secret (npm Automation token) and adds `--provenance` there. Local `npm publish`
   cannot generate provenance — if `publishConfig.provenance` is set, npm fails with
   `Automatic provenance generation not supported for provider: null`.

### Renaming or moving the project

If the npm package name, repository name or plugin id changes again:

- update `package.json` (`name`, `repository`, `homepage`, `bugs`), `dsh-plugin.json`, `cordis.patch.yml`;
- update `PACKAGE_NAME` and the legacy-cleanup constants in `install.mjs`;
- update both READMEs, the CI badge URLs and the install commands;
- keep a migration path (previous patch-block markers + previous `node_modules/<old-name>` dir) so
  existing users are upgraded cleanly, and document it in `CHANGELOG.md`.

---

## License

By contributing you agree that your changes are licensed under the [MIT License](LICENSE).
