# WP-32 Discover

Settings → Plugins lists plugins from static indexes, shows what each one adds and its licence, and offers Install only when WP-31 can pin it. Listing never runs plugin code.

The readers, the bundled index and `plugins_discover` were already on this branch (`0c0ab017`, `60c59242`). This pass adds the settings list, the screen, the browser spec, and rustfmt so `cargo fmt --check` is clean.

## What changed

- `src/features/plugins/model/discover.ts` — the index list (bundled, https, GitHub, file), a revision compare-and-swap, and the listing state. A late result is ignored. A failed refresh keeps the last good list. An unreachable index is not marked not compatible.
- `src/features/plugins/ui/DiscoverPage.tsx` — search, filter, detail (licence, source, what it adds, permissions) and Install. Install calls `plugins_install`. If that command is not in this build, the screen says so and nothing is marked installed.
- Settings hooks only: a Plugins section after Skills (`settings.ts`, `SettingsRail.tsx`, `SettingsView.tsx`), each marked `WP-32`.
- `tests/browser/discover.spec.ts` — Chromium. Screenshots are taken in the test and must be larger than 2000 bytes. Playwright removes a passing run's output folder, so the files are not left on disk.
- `docs/hivra/plugins/DISCOVER.md` — the three formats and what is offered for install.
- `src-tauri/src/plugins/discover/` — rustfmt only. No reader behaviour change.

## Done when

**Each reader maps sample entries.** Met, already on the branch, still passing inside `cargo test` (1203 passed).

- Hivra: `the_bundled_index_lists_the_five_default_plugins`, `hivra_entries_validate_one_by_one`
- DeepSeek Harness: `dsh_entries_map_and_are_marked_not_compatible`
- Claude Code: `claude_marketplace_entries_map_their_portable_parts`, `the_real_cursor_marketplace_reads`

**Incompatible entries are marked, and never offered for install.** Met. DSH entries are `not-compatible`. Claude entries that only have hooks, agents or commands are `not-compatible`. Portable Claude skills and MCP servers are listed only. `nothing_but_the_hivra_index_is_ever_offered_for_install`. The page test and the browser spec both show no Install button on the DeepSeek row.

**Listing never executes anything.** Met. `listing_never_executes_anything` asserts the reader module does not spawn a process, and a folder that contains `plugin.json`, `mcp.json` and a postinstall script is unchanged after a list. The browser spec records the commands: `plugins_discover` only, until Install, which is the only call to `plugins_install`.

**Browser spec with screenshots.** Met on Chromium, not on WebKit. `npx playwright test tests/browser/discover.spec.ts --project=chromium` — PASS (1), about 13s. The test writes `discover-chromium-list.png` and `discover-chromium-detail.png` and asserts each is larger than 2000 bytes. WebKit did not run: see below.

**`npm run check`.** Not a single green exit. Vitest exits 1 on this machine before tsc, the script tests and Rust run, on tests that are unchanged from `origin/main`. The pieces, run on their own after the last code change:

- `npx tsc --noEmit --pretty false` — TypeScript: No errors found.
- `npx vitest run src/features/plugins src/features/settings/model/settings.test.ts src/features/settings/ui/SettingsView.test.ts` — 90 tests passed. `SettingsView.test.ts` failed to load (`localStorage.getItem is not a function`) before any test. The same load failure happens with the Discover import taken out of `SettingsView.tsx`, so it is not this package.
- `node --test` on every `scripts/*.test.cjs` and `scripts/*.test.mjs` (34 files) — 282 passed, 1 skipped (`r50 drill`), 0 failed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` — clean after `94a2ee4c`.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings` — No issues found.
- `cargo test --manifest-path src-tauri/Cargo.toml` — 1203 passed, 2 ignored (17.66s).

## What I couldn't check

- **WebKit.** `npx playwright test tests/browser/discover.spec.ts --project=webkit` failed immediately: `Executable doesn't exist at /Users/ash/Library/Caches/ms-playwright/webkit-2359/pw_run.sh`. `npx playwright install webkit` was not approved, so the browser was not downloaded. The spec is not skipped.
- **`npm run check` as one command.** It stops in `vitest run`. Node is v25.2.1 and the vitest workers warn `` `--localstorage-file` was provided without a valid path ``, after which `localStorage.clear`, `setItem` and `getItem` are not functions. Confirmed on files with no diff against `origin/main`, run on their own: `hivraLayout.test.ts`, `userName.test.ts`, and `sessionRuns.test.ts` (the heartbeat test expects `['a']` and gets `[]`, which is the same broken store). Not introduced here, and not fixed here: that would mean editing tests outside this package.
- **A real `plugins_install`.** WP-31's command is not in this build. The screen treats a missing command as "Install isn't in this build yet. Nothing was installed." The browser fixture returns `{ message: "Installed pstack." }` so the success line can be seen. Nothing was installed on disk.
- **The app window.** Not launched. No `tauri`, no `hub:*`.

## For Ash (this Mac)

- Install WebKit and re-run `npx playwright test tests/browser/discover.spec.ts` so the same spec passes on WebKit.
- The full `npm run check` stays red on this Node until `localStorage` in the vitest workers is a real store again. That is outside WP-32.
