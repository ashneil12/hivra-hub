# WP-12: Delivery modes and merge authority

Branch `claude/project-thread-8hayur`. Not pushed.

## What changed

Each project can land locally, open a pull request, or open a checked pull request. Checked is the default when the project has a GitHub remote and `gh` is signed in; otherwise local. A separate "merge without asking" switch is off until it is turned on.

One merge path refuses red or pending checks, a draft, a conflict, a closed or already merged pull request, and an open question on that work. With no checks at all, the switch does not merge; the person still can. Red is never merged. Every attempt is logged with who allowed it. Inbox merge, squash, and rebase go through that path.

A checked pull request that is already green or red on the first watch read leaves "checking" once. One red check sends one fix round; a later red fails it. A timeout or a failed read does not mark the delivery failed.

Settings and delivery state only change if nothing newer wrote them. Two windows cannot overwrite each other. Project keys fold `.` and `..`, including a missing path, a space, and `café`, and a `..` that escapes a relative path does not collide with a bare name.

`git` and `gh` started by delivery get an allow-listed environment. Teardown still refuses a worktree whose work has not landed or merged. The janitor does not offer to remove a landed but unmerged copy.

`src-tauri/src/delivery/WIP.md` is gone.

No new screen. WP-15 is the first-mate UI.

## Done when

**Tests for each mode, the merge refusals, and the teardown guard.** Met.

Modes use a local bare repo (`url.<file>.insteadOf` for `https://github.com/acme/web.git`) and an in-process `gh` stand-in (`FakeGithub`). They do not spawn a `MONOCODE_PR_WATCH_GH` binary. The dev-copy env var is wired the same way as the PR watch; the daily app does not read it.

- `the_default_is_checked_pr_with_a_github_remote_and_gh_signed_in_otherwise_local` (also path keys: `..`, a trailing slash, a space, `café`, a relative escape, and a real directory)
- `local_lands_the_change_in_the_project_and_pushes_nothing`
- `pr_pushes_the_branch_and_opens_a_pull_request_with_the_brief_and_evidence`
- `a_pr_mode_refuses_uncommitted_work_and_records_nothing`
- `checked_pr_is_ready_only_when_green_and_gets_one_fix_round_for_red`
- `a_checked_pr_already_green_or_red_on_the_first_read_settles_once`
- `the_fix_round_carries_the_failing_log`
- `pr_watch_reads_classify_as_ci_red_green_merged_and_closed`
- `decide_refuses_red_pending_drafts_conflicts_and_open_decisions`
- `an_agent_merge_asks_the_person_and_merges_only_the_head_they_allowed`
- `the_switch_merges_green_without_asking_and_never_red`
- `an_open_question_on_the_work_blocks_even_the_persons_merge`
- `the_inbox_merge_button_goes_through_the_same_path`
- `a_stale_settings_write_does_not_overwrite_a_newer_choice`
- `a_git_child_does_not_inherit_the_process_environment` (unix)
- `teardown_keeps_a_copy_whose_work_has_not_landed_or_merged`
- `the_janitor_never_offers_to_remove_a_landed_but_unmerged_copy`

A Windows path assertion is `#[cfg(windows)]` inside the default-mode test and did not run here.

Evidence, after these commits, from `src-tauri`:

```
cargo test --manifest-path src-tauri/Cargo.toml --lib delivery -- --test-threads=8
cargo test: 23 passed, 1154 filtered out (1 suite, 1.13s)
```

**`npm run check` passes.** Not as one command.

Rust, on this tree before the commits (the commits are that tree, plus deleting the pause note):

```
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
(exit 0)

cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings
cargo clippy: No issues found

cargo test --manifest-path src-tauri/Cargo.toml --workspace -- --test-threads=8
cargo test: 1207 passed, 2 ignored (5 suites, 26.65s)
```

TypeScript, no errors. This diff does not change `src/` or `tests/`:

```
npx tsc --noEmit
TypeScript: No errors found
```

Web tests did not pass:

```
npx vitest run
PASS (6585) FAIL (1088) skipped (13)
```

The failures are `localStorage.clear` / `setItem` / `getItem` / `removeItem` is not a function, then `Cannot read properties of undefined (reading 'unmount')` where `beforeEach` threw. Node is v25.2.1; its global `localStorage` is not a Storage unless `--localstorage-file` is set, and happy-dom tests call it. A few assertion mismatches also show up in tests this diff does not touch (`Codex week` wording, `invader` / `cat`, and others). No missing-module errors. These are not delivery failures, and no test was skipped or weakened.

Script tests: `npm run check:scripts` still returned "requires approval" and did not run. Earlier, `node --test scripts/hub-dev-loop.test.cjs` passed 22.

## Commits

- `e1018c39` WP-12: claim delivery modes and merge authority
- `f98aef0d` WP-12: delivery engine, merge path, teardown guard and tests (WIP, not yet compiled)
- `661c38b7` WP-12: settle a checked PR on the first read
- `84f71e79` WP-12: drop the pause note

## Couldn't check

- `npm run check` as one command.
- The full script suite (`scripts/*.test.cjs` and `scripts/*.test.mjs`), apart from `hub-dev-loop.test.cjs`.
- A green vitest run on this machine (Node 25 `localStorage`).
- The `#[cfg(windows)]` path assertion.
- A `MONOCODE_PR_WATCH_GH` binary. Mode tests use `FakeGithub`.
- No network and no `gh`, so nothing was pushed and PR #16's description was not updated.

## For Ash (Mac)

- A dev copy (`npm run hub:dev`) with a real `gh` login: default mode, opening a pull request, and a checked pull request whose checks are already green or red.
- A red required check, one fix round, then a second red.
- Merge from Inbox, and merge with the switch on, including a pull request with no checks.
- Removing a worker copy from orchestration before and after the work has landed.
