# WP-113: Optional settle, snooze and re-sort for the chat list

The chat list can settle a finished chat, snooze a chat until a time, and bring a chat that needs you back to the top. The switch is off by default, so today's list stays as it is. Settled and snoozed chats stay on this machine. They are not deleted, and a running terminal is not closed. Being built is not read and is not re-sorted.

Auto-settle on merge is decided and tested, and it is not hooked up. See below.

## What changed

- Setting `chatListInbox` (`monocode.chatListInbox`), off unless the stored value is `1` or `true`. Settings copy: "Settle and snooze". The row is in the chat settings search index.
- Settle, unsettle, snooze, and unsnooze live in `monocode.chatListInboxState`. Two windows merge by a per-chat touch. A failed write stays in memory and the next change tries again. A timeout is not treated as a final failure.
- With the setting on, settled and snoozed chats leave the active list and sit on shelves. One notice can undo the last action. A snoozed chat wakes early for an approval, a question, a failure, or the person's own message, and hides again if that passes before the time.
- With the setting on, a chat that needs the person, or that just got a reply, sorts above the rest. Pins still win. With the setting off, the order is the same as today (pin, then last update, then id).
- `autoSettleOnMerge` and `settleIfMerged` settle only when the person has not written since the merge. They are not called from the PR watch.

## Done when

- The setting is off by default and old settings stay off. `displayPrefs.test.ts` ("chat list inbox migration") reads a missing key as off, and reads `""`, `"0"`, `"false"`, `"yes"`, `"on"`, `"2"`, `"true "`, and `" TRUE"` as off. Only `"1"` and `"true"` are on.
- With it off, the list order and rows are unchanged. `chatListInbox.test.ts` ("leaves the list unchanged while the setting is off, even if marks exist" and "matches today's order when the setting is off, even if a chat needs the person"). The browser spec keeps a settled mark on screen and keeps the old order until the switch is turned on.
- With it on, settle, snooze with early wake, unsnooze, unsettle, and undo work, and Being built does not re-sort. Covered in `chatListInbox.test.ts` and `chatListInboxStore.test.ts` (including two windows, a thrown read, and a rejected write). The model test "does not read Being built or delete a session" reads the module source and rejects imports of the Being built modules. Shelves, the status notice, and Undo are in `ChatListInbox.test.tsx`.
- Browser spec is green on Chromium and WebKit. See commands.
- No em dashes or en dashes in text a person sees. The shelf, notice, dialog, and menu tests assert that, and the browser spec checks the page text. The settings sentence uses commas and periods.

## Auto-settle is not hooked up

Item 5 asked for a small hook on the existing PR-watch path, and to skip it if that hook would be more than a small change.

A watch is owned by a session (`owner_session` in `src-tauri/src/pr_watch`). Wakes go to that owner. The chat list never shows a Mono session (`!isMonoSession` in `src/app/shell/Sidebar.tsx`), and a PR watch's owner is a Mono chat. Connecting a merged watch to a listed chat means mapping `worktree` onto a listed session and knowing whether that person has written since the merge. That is more than a small change to `src/features/pr-watch` and `src-tauri/src/pr_watch`, so the live behavior is not wired. The decision is tested: a message at the merge time still settles, a later message does not, a message with no time does not, and a later agent update is not the person resuming.

## Commands

`npx vitest run src/features/settings/ui/SettingsView.test.ts src/features/settings/model/settings.test.ts`

PASS (105) FAIL (0). This is the run after the search-index fix.

`npm run check` (web, then scripts, then Rust)

- Web: `vitest run && tsc --noEmit`. Test files 1253 passed, 2 skipped (1255). Tests 10212 passed, 13 skipped (10225). `tsc` did not print an error (the script continued).
- Scripts: tests 417, pass 415, fail 0, skipped 2.
- Rust: `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` completed, then `cargo test` failed in `monocode` lib: 2109 passed, 4 failed. The four were `outside::tests` door tests (`the_door_is_off_until_this_copy_turns_it_on`, `the_door_uses_the_same_port_after_a_restart`, `turning_the_door_off_and_on_keeps_the_port`, `two_copies_of_the_door_body_run_at_the_same_time`). Each failed because the port was already in use (os error 48). This package does not change Rust.

Those four, rerun alone with `--test-threads=1`: 1 passed each.

`cargo test` again after that: 2145 passed, 4 ignored (5 suites, 41.14s).

Browser, committed config (`playwright.config.ts`, port 1435):

`npx playwright test tests/browser/wp113-chat-list.spec.ts --project=chromium --project=webkit`

Did not run tests. Playwright exited 1 because `http://127.0.0.1:1435/tests/browser/transcript.html` was already in use, and `reuseExistingServer` is false. The config was not changed, and the process on that port was not killed.

Same spec, same Chromium and WebKit projects, vite on port 1475 (a throwaway config, not committed):

PASS (4) FAIL (0). Time 8.5s. Two tests, once on each engine: the setting off leaves the list alone, and settle, undo, snooze, and unsnooze work only while the setting is on.

## Not checked

- The running app. No dev copy was launched.
- Auto-settle on a real merged PR. Not hooked up, on purpose.
- The first full `npm run check` is not a single green run. Web, scripts, fmt, and clippy passed in that run. The Rust suite passed on the later `cargo test`.

## Mac-only checks for Ash

- `npm run hub:dev` in this worktree. Turn on Settle and snooze. Settle a chat, open Settled, undo. Snooze a chat, open Snoozed, unsnooze. Turn the setting off and confirm the old order is back.
- Settle a chat that has a terminal still running a command. The command should keep running. Nothing in this package closes a terminal, but that was not tried in the app.
- Being built should keep its order while the setting is on.
