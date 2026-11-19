# WP-202: PR watch knows when main moved under a pull request

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M (overnight suggestion) | M | WP-155 and WP-160 (briefs on main); WP-158 (open PR #198) if the refusal sits in the same merge gate | no |

## Goal

A pull request that went green on an old main, while another change landed on main and touched the same files, is
not merged on that green. The PR watch notices the base moved, says so once, and the merge gate refuses until the
crew has rebased and CI has run again. Pull requests that never touch the moved files keep shipping.

## Why

With many crews merging into one main, the risky case is rarely a red check. It is a pull request that is green on an
old base, while a change that landed since touches the same code. GitHub can still report it as mergeable, because
the text does not conflict, but the combined code has never been tested together.

`src-tauri/src/pr_watch/github.rs` reads `mergeable`, `reviewDecision` and `baseRefName`. It does not read
`mergeStateStatus` or the base commit id, so it cannot tell when the base moved, or that the PR is BEHIND or DIRTY.
A search of `src-tauri/src/pr_watch/` finds no base tracking at all.

WP-155's merge helper pins the merge to the head SHA, which stops a push that lands after the check. It does not
stop a base move, because the head does not change when main does.

## Read first

- `src-tauri/src/pr_watch/` (the GraphQL read, the watch store, the wake events) and its `fixtures/`.
- WP-155 (`scripts/hivra-ship-green.mjs`) and WP-160 (the lead tick reads PR watches and calls the one merge path).
- The merge path used by delivery (`delivery_merge`). The gate goes there, not in a second place.

## Build

1. **Read the base and the merge state.** Add `mergeStateStatus` and the base commit (`baseRef { target { oid } }`) to
   the PR read. Store `base_oid` and `merge_state` on each watch, with a migration the existing schema guard accepts.
   A missing field reads as unknown, never as a block. Test: a fixture with the new fields parses; a fixture without
   them parses and blocks nothing.
2. **Wake events, once per head.** (a) "main moved to <sha7> and touches files in this PR: a, b, c", when the files
   changed between the old and new base (`compare`) overlap the PR's own changed files (`gh pr diff --name-only`,
   cached per head). (b) "BEHIND: update from main before merging". (c) "DIRTY: conflicts with main, rebase".
   Each is keyed by head SHA and base SHA, so a repeat poll never fires it again. Test, with the
   `MONOCODE_PR_WATCH_GH` stand-in: a base move touching a PR file fires once; a base move touching other files does
   not fire; a second poll fires nothing new.
3. **The merge gate.** Refuse the merge when the PR is BEHIND or DIRTY, or when base commits that landed after the
   last green run touch the PR's files. The refusal names the reason and asks the crew to rebase, push and wait for
   green again. The state is read again just before the merge (the same pattern WP-160 uses), so a move that lands
   during the read still holds it. Test: BEHIND refuses; DIRTY refuses; an overlapping base move refuses; a
   non-overlapping base move merges; a move that lands between the read and the merge refuses.
4. **Summary line.** A green or ready summary says "N commits behind main" when N is above zero, from one cached
   `compare` call. Test: N is shown for N above zero and hidden at zero.
5. **Rate limit.** When GraphQL is rate-limited, read the same facts over REST (`repos/<r>/pulls/<n>`,
   `commits/<sha>/check-runs`). Test: a stand-in that returns a rate-limit error still produces the same state from
   the REST path.
6. **Stale state.** A watch state older than six hours starts a fresh baseline rather than replaying old comments or
   old base moves. Test: a seven-hour-old state produces no events on its first read.
7. **First Mate default behaviour (prompt text only).** Add three or four lines to the crew delivery brief: keep a PR
   at the size its goal needs; when a review bot suggests more, fix real bugs in scope and decline the rest with one
   written reason, listed as follow-ups. Test: the brief template contains those lines (a string test).

## Done when

- [ ] Tests for steps 1 to 7 pass; `npm run check` is green.
- [ ] A dev copy on Ash's Mac, with two throwaway PRs on a test repo: moving main under one of them shows "main moved"
      on its card and blocks its merge. Until that check runs, the package is open.
- [ ] No change to who may merge; the gate only adds refusals.

## Out of scope

- Automatic rebase. The crew does the rebase.
- A merge queue, branch protection changes, or new GitHub Actions workflows.
- Blocking pull requests that do not touch the moved files.
- Any write to GitHub beyond the merge the lead already runs.

## Licence

Logic from Theo Browne's `tstack` (MIT, https://github.com/t3dotgg/tstack, `skills/babysit-pr/scripts/pr-wait`), written
fresh in Rust. Credit in `NOTICE` and `docs/hivra/credits.json` when code lands.

## Sources

- tstack `babysit-pr` and `full-send` skills (MIT), read for the logic only.
- Overnight scout suggestion, 10 Nov 2026.
- `src-tauri/src/pr_watch/github.rs` on main (the fields read today).
