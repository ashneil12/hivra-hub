# WP-155: Ship on green, and record where the time went

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Pipeline speed (9 Nov 22:11 UK) | S | After WP-153 (auto-merge is useless while known flakes keep CI red) | yes |

## Goal

Once CI is honestly green, a non-security pull request that has passed the lead check can merge within a few minutes of that green, and every shipped pull request can leave a short record of CI time and merge-wait time.

## Why

Measured 9 Nov 2026 22:12-22:22 UK. #99 opened at 15:18 and merged at 15:35 (16.5 minutes) when CI was a 15.6-minute success. #106 opened at 21:17 and merged at 21:46 (29 minutes) after CI finished at 21:36: ten minutes of merge wait, and that was a good case. Earlier pull requests the same day took 55-100 minutes open-to-merge, mostly because CI was red on known flakes or stuck in Playwright install. The lead tick was 30 minutes and is now 15, so a finished run can still sit for a quarter of an hour. There is no single place that records CI time and merge-wait time for the morning rundown.

This package does not change GitHub workflow permissions, does not add a bot token, and does not turn on a merge queue. The lead already has `gh` rights to merge. The work is a small, tested script plus this note.

## Read first

- The measurements in Why, above. They are the reason this package exists.
- Merge rules already in use: merge commit only, pin to the head sha, never force-push, never merge WP-92 or another security-park package, compare failing check titles not counts. Title comparison stays with the lead. This script only reports a real success; merging stays with the lead, after review.
- `scripts/ci-ok.mjs` (WP-105's required check). Do not add a second required-check workflow.

## Build

1. **Docs first.** This file. Commit it first.
2. **A lead script in the repo,** with tests. `scripts/hivra-ship-green.mjs` (Node, no new dependency). It should:
   - Accept one or more pull request numbers.
   - Refuse security-park titles, labels, and a hard-coded list that includes WP-92 plus the packages marked never-merge (WP-150, WP-158). Extra ids can be passed on the command line.
   - Read the latest CI run for the pull request head sha. Exit non-zero if the run is red, pending, missing, or the head sha does not match.
   - Optionally append a line to a log file (path as an argument, default off) with: pull request number, head sha, builder start and end if provided, CI minutes from the run's created and updated times, and minutes from CI completion to now. Do not invent times.
   - Print the exact `gh` merge command for the lead, and never run it. Merge method is `merge`, pinned to the sha. (A first build had an `--apply` that merged; it was taken out on 10 Nov 2026 so every merge goes through the lead's review.)
   - Not request or store tokens. Use the environment's existing `gh` auth.
3. **Tests** with a fake `gh` covering: green is mergeable; red CI refuses; sha mismatch refuses; security-park refuses; a ready pull request prints the pinned command and nothing merges; `--apply` is refused.
4. **Out of scope.** Do not add a GitHub Actions workflow with `contents: write` or `pull-requests: write`. Do not enable a merge queue or change branch protection. Do not auto-merge from Actions. Do not weaken the lead check (`npm run check` stays with the lead, one package at a time).

## How the lead ships

Run the lead check first. This script does not run it. Ship only when that check exits 0.

Then confirm CI on the pull request head is a real success. After WP-153, green means the suite passed, not "only known flakes". This script reads the latest CI run for that sha and refuses anything else.

Check a pull request (prints the merge command, never merges):

```sh
node scripts/hivra-ship-green.mjs 123
```

From outside a checkout, pass the repo as well:

```sh
node scripts/hivra-ship-green.mjs --repo OWNER/NAME 123
```

For a pull request that passed, it prints:

```sh
ready: gh pr merge 123 --repo OWNER/NAME --merge --match-head-commit <head sha>
```

The lead runs that command after review. The sha pin means a push that lands after the check is not merged.

The command does not pass `--auto`. The script prints it only after it has seen a success, and only for a pull request that is not security-park.

Several numbers are one batch. If any one fails the checks, no command is printed for any of them.

Timings are off unless you pass a log path. The script appends one line per pull request that passed the checks. `ci_minutes` is the CI run's updated time minus its created time. `merge_wait_minutes` is now minus the run's updated time. `builder_start` and `builder_end` are written only when you pass them. A time the script did not read is left out. It does not fill one in.

```sh
node scripts/hivra-ship-green.mjs --log ship-times.log --builder-start 2026-11-09T21:00:00Z --builder-end 2026-11-09T21:18:00Z 123
```

A line looks like this (fields with no reading are absent):

```text
pr=123 sha=<head> ci_minutes=15.60 merge_wait_minutes=1.40 builder_start=2026-11-09T21:00:00Z builder_end=2026-11-09T21:18:00Z
```

After the merge, rebase or merge main into open siblings that do not conflict. Never pass `--force`. Never pass `--no-verify`. Never push main. Never merge a security-park package.

Built-in never-merge packages are WP-92, WP-150 and WP-158. A `security-park` label (any spelling of that label) is refused too. Add another id without editing the script:

```sh
node scripts/hivra-ship-green.mjs --never-merge WP-152 123
```

A title, branch or label that names one of those packages is refused even when CI is green.

## Done when

- [ ] `scripts/hivra-ship-green.mjs` exists, never merges, and its tests pass.
- [ ] This note tells the lead the exact command, including how timings are logged.
- [ ] `PR.md` is clear that this does not merge anything by itself in CI.
