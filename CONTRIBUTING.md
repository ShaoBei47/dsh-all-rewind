# Contributing to dsh-all-rewind

Thanks for taking the time to improve the project. This document is for contributors and maintainers;
if you only want to install and use the plugin, read [README.md](README.md) (or the
[Chinese README](README.zh-CN.md)).

---

## Ways to contribute

- **Bug reports** — include the DSH version, plugin version (`rewind_status`), platform, the rewind point
  involved, and the exact result (restored / skipped files, warnings, console errors).
- **Feature requests** — describe the workflow you want, not only the implementation.
- **Pull requests** — keep changes focused; open an issue first for larger features or refactors.

For anything related to unsafe file behavior (deleting user files, path traversal, remote code execution),
please report it privately to the maintainer instead of opening a public issue.

---

## Development setup

Requirements:

- Node.js **22 or newer** (the project is ESM-only);
- no package manager install step — there are **zero runtime dependencies** and no build step.

```bash
git clone https://github.com/ShaoBei47/dsh-all-rewind.git
cd dsh-all-rewind
node --version          # >= 22
```

### Test commands

```bash
npm test          # node --test test/  (spawns one process per test file)
npm run test:all  # run every test file inside one process (for sandboxes that forbid spawning)
npm run smoke     # end-to-end smoke test without a DSH host
npm run smoke     # prints PASS/FAIL for each end-to-end check
```

`test/real-cordis.test.js` and `test/loader.test.js` boot the plugin with a real Cordis build when one is
available and skip otherwise. Point them at a build with:

```bash
# Windows PowerShell
$env:DSH_CORDIS_PATH = "C:\path\to\@deepseek-ai\cordis\lib\index.js"
npm run test:all
```

### Linting / formatting

There is no linter or formatter configured on purpose (the plugin must stay dependency-free and easy to audit).
Match the surrounding style: ESM, two-space indentation, no semicolons, single quotes, English code comments.

---

## Project layout

| Path | Purpose |
| --- | --- |
| `lib/index.js` | Cordis plugin entry: event listeners, tools, routes, UI injection |
| `lib/manager.js` | Session → snapshot store mapping, turn tracking, auto maintenance |
| `lib/store.js` | Snapshot capture / restore / prune / GC |
| `lib/tree.js` | Content-addressed directory trees (structural sharing) |
| `lib/objects.js` | Content-addressed blob store (zlib + sha256) |
| `lib/workspace.js` | Workspace scan, manifest diff, restore planner |
| `lib/http.js` | Local HTTP API with Host/CSRF checks |
| `assets/ui.js` | Client-side rewind actions under each prompt |
| `install.mjs` | Profile installer / uninstaller (`--source`, `--data-dir`, migration) |
| `test/` | Unit, integration, client-DOM, installer, loader and smoke tests |

### Design constraints to keep

1. **No runtime dependencies, no build step.** The plugin is copied into a DSH profile as plain ESM files.
2. **Never spawn subprocesses** for core snapshot logic — confined hosts forbid it; the built-in
   content-addressed store replaces a `git` dependency.
3. **Never delete files a snapshot has not seen.** Restore plans must stay conservative; a truncated scan
   must refuse the rollback instead of guessing.
4. **Treat the local HTTP API as hostile input.** Keep the loopback Host, same-origin and CSRF checks,
   and never accept arbitrary filesystem paths from requests.
5. **Snapshot data is user data.** Never rewrite or delete a snapshot directory without an explicit
   user-triggered maintenance action.

---

## Test matrix

| File | Covers |
| --- | --- |
| `test/store.test.js` | Repository layout, anchors, tree sharing, blob dedupe, restore, conflicts, truncation, pruning, maintenance, previews |
| `test/manager.test.js` | Session event → snapshot timing, tool skipping, read-only sessions, auto maintenance |
| `test/plugin.test.js` | Tools/routes/UI injection registration, HTTP revert, Host/CSRF rejection, bad workspace |
| `test/ui.test.js` | Real `assets/ui.js` in a DOM stub: per-prompt actions, payload, re-attach, session switch |
| `test/config.test.js` | Storage location precedence, legacy env var, auto-maintenance defaults |
| `test/install.test.js` | Installer/uninstaller, `--data-dir`, `--source`, legacy `dsh-trae-rewind` migration |
| `test/real-cordis.test.js` | Plugin loads and disposes inside a real Cordis context (auto-skip) |
| `test/loader.test.js` | Real Cordis loader imports the package from a profile by name (auto-skip) |
| `test/smoke.mjs` | Full turn flow → tool rollback → HTTP rollback → maintenance |

A PR should keep `npm test` (or `npm run test:all`) and `npm run smoke` green, and add a test for behavior
changes. If your environment cannot spawn processes, use `npm run test:all`.

---

## Release checklist (maintainers)

1. Update `CHANGELOG.md` (add an entry with the new version, date and notable changes).
2. Bump `version` in `package.json` — and keep `dsh-plugin.json` and the `version` constants in
   `lib/index.js` / `lib/manager.js` in sync.
3. Run the full checks:

   ```bash
   npm run test:all
   npm run smoke
   npm pack --dry-run   # must contain only runtime files (no tests)
   ```

4. Commit, tag and publish:

   ```bash
   git tag v0.4.0
   git push origin main --tags
   npm login
   npm publish --access public   # local publish; provenance is added by the CI workflow
   ```

5. The repository ships `.github/workflows/publish.yml`, which runs the tests and publishes when a `v*` tag is
   pushed. It expects an `NPM_TOKEN` secret in the repository settings (npm Automation token) and adds
   `--provenance` there. Local `npm publish` cannot generate provenance — if `publishConfig.provenance` is set,
   npm fails with `Automatic provenance generation not supported for provider: null`.

### Renaming or moving the project

If the npm package name, repository name or plugin id changes again:

- update `package.json` (`name`, `repository`, `homepage`, `bugs`), `dsh-plugin.json`, `cordis.patch.yml`;
- update `PACKAGE_NAME` and the legacy-cleanup constants in `install.mjs`;
- update both READMEs, the CI badge URLs and the install commands;
- keep a migration path (previous patch-block markers + previous `node_modules/<old-name>` dir) so existing
  users are upgraded cleanly, and document it in `CHANGELOG.md`.

---

## License

By contributing you agree that your changes are licensed under the [MIT License](LICENSE).
