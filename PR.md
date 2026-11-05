# WP-79: the door must not take the app down, and it stays on one port

Integration-lead fixes on `wp/79-outside-tools`. Not merged, not pushed.

## What changed

`cf546b6c` — `outside::init` always returns Ok. If the database cannot be opened, or the saved port cannot be bound, the error is logged (`outside: …`) and Connected apps can read it as `couldn't start: <reason>`. The door no longer binds port 0. It stores one port in `outside_settings` (`port`) and reuses it. Daily copies use 27179–27199. Dev copies use 27200–27399, and a saved port outside that range is replaced. A port that is already taken stays saved until `outside_pick_new_port`.

`1c6243c1` — Connected apps shows that reason, hides the URL while it is set, and shows **Pick a new port** only when `portTaken` is true.

This commit — the file-backed port tests no longer share those fixed ranges. `a_taken_port_stays_put_until_a_new_one_is_asked_for` was binding a daily-range port the door had just used, so `hold` panicked when that port was still taken. Each such test now binds `127.0.0.1:0`, keeps or drops that listener itself, and hands only that port to the door. Production still passes the copy's range. The door's rules are unchanged: a saved port is reused, a taken port is reported and not moved, and a new port is chosen only when asked.

`lib.rs` only registers `outside_pick_new_port` next to the other WP-79 commands.

## Lead fixes

Startup must never fail because of the door.

- `init_still_opens_when_the_database_cannot`: a database whose parent is a file. `init_at` returns Ok, `problem` starts with `couldn't start:`, `url` is none, `port_taken` is false, and the log note is recorded.
- `init_still_opens_when_the_port_cannot_be_bound`: the test holds a port it reserved and saves that port. `init_ports` returns Ok, the problem names that port, `port_taken` is true, enabled stays true, and the stored port does not change.

Stable port. A dev copy never uses the daily app's port. A taken port is reported and is not moved until asked.

- `the_door_uses_the_same_port_after_a_restart` and `turning_the_door_off_and_on_keeps_the_port`: the door is given one reserved port, and that same port is bound again after a restart and after off then on.
- `a_dev_copy_never_binds_the_daily_range` and `a_dev_copy_does_not_bind_a_saved_daily_port`. The second stores `27179` without binding it. A dev copy replaces it with a port in 27200–27399.
- `a_garbage_saved_port_is_not_bound` (stored value `..\r\n0`) still replaces it with a daily-range port.
- `a_taken_port_stays_put_until_a_new_one_is_asked_for`: one reserved port stays held. Startup reports it taken and does not bind the other reserved port. `pick_new_ports` binds that other port, and a new bind of the old port still fails.
- `asking_for_a_new_port_does_nothing_while_this_one_works`.
- `a_second_door_does_not_take_the_port_from_the_first`.
- `no_free_port_is_reported_without_failing_startup`: the only port the door is allowed is held. Startup returns Ok, `port_taken` is false, and nothing is stored.

## Package done when

- Orbit PKCE, grant, revoke, refresh, code reuse, Origin, Host, and body limit: already covered by the existing `outside::tests` cases. They passed again inside `npm run check` (`cargo test`: lib 1719 passed, 0 failed, 2 ignored). This change did not re-port them.
- `npm run check`: passed. See commands.
- Dev-copy `claude mcp add`, list tasks, disconnect: not run. Needs a dev copy and a Claude login. The stable port is what makes a saved `claude mcp add` survive a restart.

## Commands

- `cargo test -p monocode --lib outside -- --test-threads=8`, five times in a row. Each run: 49 passed, 1672 filtered out, 0 failed.
- `npm run check`:
  - vitest: 9482 passed, 13 skipped (1167 files passed, 2 skipped).
  - `tsc --noEmit`: clean (the script tests ran after it).
  - script tests: 321 pass, 0 fail, 2 skipped.
  - `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test`: lib 1719 passed, 0 failed, 2 ignored; the other crate 32 passed, 0 failed; doc-tests 0 failed.

Browser specs were not re-run for this commit. The earlier Chromium run of `tests/browser/wp79-outside.spec.ts` (5 passed) is unchanged: the page still fakes the text "port 27179".

## Not checked

- WebKit. Playwright's WebKit is not installed (`/Users/ash/Library/Caches/ms-playwright/webkit-2359/pw_run.sh` missing). It was not downloaded. Not re-tried this commit.
- Windows runtime. `x86_64-pc-windows-gnu` is not an installed rustup target, so the Windows clippy was not run. The new code uses `std::net` only. No `std::os::unix`.
- A real dev copy and `claude mcp add`. Not launched, so the saved URL was not pasted into Claude.
- The daily app. Not launched.

## Mac-only, for Ash

- On a dev copy, turn the door on, copy the URL, quit, open again, and confirm the URL is the same and `claude mcp add` still answers.
- Hold that port from another process, open the app, and confirm Connected apps says `couldn't start: port … is already in use` and **Pick a new port** moves it. The app itself should still open.
- WebKit, once `npx playwright install webkit` has been run: `npx playwright test tests/browser/wp79-outside.spec.ts --project=webkit`.
