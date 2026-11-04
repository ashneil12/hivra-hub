# WP-31: Plugin install, update and rollback

Pinned install, update, rollback and uninstall, with a compatibility check before download and a person's OK before any script or any install an agent starts. Settings → Plugins is the Installed list. Waiting installs also sit at the top of the Inbox. No new Inbox kind.

## What changed

- Sources stay pinned: a git commit or tag, an npm version such as `1.2.3`, or a local folder. A branch, a short id, `latest` or a range is refused before git or npm runs.
- A git folder on this machine has `plugin.json` read and checked before any clone. A remote commit is still fetched into a scratch repository with no checkout, then checked, then unpacked.
- Stage, validate with the WP-30 loader, swap. A failure after the swap puts the previous version back. `lock.json` records version, source and a digest only.
- A setup command, or `npm install` for an MCP server, is shown and does not run until Allow. An agent install waits even when nothing would run. Decline leaves no plugin and no pending request.
- Update keeps the old copy until the new one validates. Roll back restores it in one step. Uninstall runs the disposers and removes the files, the previous copy and the lock entry.
- A skill that stops passing the check is unlinked from `~/.agents/skills` as well as left out of the session.
- Commands: `plugins_install`, `plugins_update`, `plugins_approve`, `plugins_decline`, `plugins_pending`, `plugins_rollback`.

## Done when

- Pinned install from a local git repo. Met. `plugins::install_tests::a_tag_installs_the_commit_it_points_at_and_uninstall_leaves_no_trace` installs a tag in a folder whose path has a space and `ü`, pins the commit the tag points at, and uninstall leaves the host tree and home as they were, including no `lock.json`.
- Incompatible platform refused before download. Met. `incompatible_platform_is_refused_before_any_download` and `incompatible_hivra_version_is_refused_before_any_download` call `source::fetch` and assert `work/repo` and `work/plugin` were never created. The platform case also asserts `install` leaves the host unchanged.
- A failing validation restores the previous version. Met. `a_failing_update_puts_the_installed_version_back` forces a failure after the swap, checks the error says the old version was put back, and checks the file, the lock and the skill link are still the first version.
- A script waits for approval. Met. `a_script_waits_for_approval_and_nothing_runs_before_it`, `npm_install_is_shown_and_not_run_until_the_person_says_yes`, `a_shell_line_is_refused_and_nothing_is_left_waiting`, and (unix) `an_approved_script_runs_inside_the_plugin_and_sees_no_secrets`.
- An agent-started install lands in the Inbox. Met. `an_agents_install_waits_and_declining_leaves_nothing` (an empty kind waits too). The Inbox mounts `PluginApprovals` (WP-31 comment in `InboxView.tsx`). `pluginInbox.test.ts` checks the card copy and that Don't install calls `plugins_decline`.
- Rollback and uninstall leave the lock file and folders as before. Met. The update test rolls back once, refuses a second rollback with "no earlier version", then uninstall matches the tree from before the install. The tag test covers uninstall of a first install.
- Browser spec for the Installed list. Chromium passed. WebKit did not run. See below.
- `npm run check`. Web and scripts passed. The Rust script did not finish inside `npm run check`. The same Rust commands passed with a private build directory. See below.

## Commands and output

`npm run check` (twice, 2026-11-04). Both times:

```
Test Files  1030 passed | 2 skipped (1032)
     Tests  8529 passed | 13 skipped (8542)
```

`check:scripts`: `# pass 282`, `# fail 0`, `# skipped 1`.

`check:rust` then failed before clippy analysed anything:

```
error: failed to run custom build command for `monocode`
thread 'main' panicked at src-tauri/build.rs:184:10:
plugins folder: Os { code: 2, kind: NotFound, message: "No such file or directory" }
```

That `build.rs` is not this branch's. It is the one in `~/Worktrees/hivra-wp-12`, which embeds `src-tauri/plugins`. Both worktrees share `CARGO_BUILD_BUILD_DIR=~/Library/Caches/monocode-hub/cargo-build`, and WP-12 was running `npm run check` into that cache while this one ran. This branch's `build.rs` has no plugins folder and does not panic there.

The Rust check, with `cargo --config build.build-dir="<worktree>/target/build-scripts"` so the build script is this branch's:

- `cargo fmt --check` passed (the following clippy started).
- `cargo clippy --workspace --all-targets -- -D warnings` finished with no warnings (`Finished dev profile` in 11.72s, then tests ran).
- `cargo test` then failed one test: `plugins::tests::the_wiring_snapshot_for_the_session_test_is_current`, because an install now writes `lock.json` and the committed wiring snapshot did not list it. The fixture was updated to that snapshot. `src/features/plugins/model/pluginSessions.test.ts` still passed (2 tests).
- `cargo test` again: monocode lib `1206 passed; 0 failed; 2 ignored`. mobile-link `32 passed`. Doc tests `0`. No failed line.

`cargo test --offline --lib plugins::install_tests`: `14 passed` (also once more against the shared cache, after WP-12 had stopped: `14 passed`).

`npx playwright test tests/browser/installed-plugins.spec.ts --project=chromium --project=webkit`:

- Chromium, "installed plugins update, roll back and remove": passed (749ms). Roll back to 0.9.0, remove, and update sending `{"kind":"npm","package":"demo-plugin","version":"1.2.3"}`.
- WebKit: failed before the test. `browserType.launch: Executable doesn't exist at ~/Library/Caches/ms-playwright/webkit-2359/pw_run.sh`. No WebKit build is on this machine. Playwright's message says to run `npx playwright install`. This session has no network, so that was not run. The spec was not changed.

`npx vitest run` of the new plugin tests, settings and inbox (earlier in the session): 144 passed. Those files are inside the later full vitest run of 1030 files.

## What I could not check

- One `npm run check` exiting 0. Web and scripts did. `npm run check:rust` keeps compiling WP-12's build script out of the shared cache, so it panics on a missing `plugins` folder. The fmt, clippy and test commands that script runs did pass with a private build dir, after the wiring snapshot included `lock.json`.
- WebKit. The browser binary is not installed and could not be downloaded.
- The native window, a dev copy, and a real npm registry. The app was not launched (`hub:dev`, `tauri build` and `hub:*` were out of bounds) and there is no network. npm behaviour is covered with a stand-in `npm` that must not run until the person allows, and then only the pinned install arguments.

## For Ash (Mac)

In a dev copy (`npm run hub:dev`, not done here): Settings → Plugins, update / roll back / remove on a real plugin, and an agent install showing in the Inbox with Allow and Don't install.
