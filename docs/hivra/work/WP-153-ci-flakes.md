# WP-153: Fix or quarantine known CI flakes, and fail hung jobs fast

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Pipeline speed (9 Nov 22:11 UK) | M | none (do this first) | yes |

## Goal

CI on main and on ordinary PRs stops going red for the known flake titles, and a hung Windows or Playwright-install job fails in minutes instead of sitting until a person cancels it or GitHub's 6-hour default fires.

## Why

Measured 9 Nov 2026 22:12-22:22 UK. Of 13 completed red CI runs whose failed logs were read, 10 failed WebKit `tests/browser/agents-page.spec.ts:152`, 4 failed `:23`, and 3 failed WebKit `tests/browser/video-preview.spec.ts:3`. The lead already merges when only these titles fail, so the code is treated as fine, but every run still looks red and a re-run costs 20-30 minutes (61 minutes on #105's earlier CI when Playwright install also stalled). `playwright.config.ts` has `workers: 1` and no retries.

Hung jobs are worse. `ci.yml` sets no `timeout-minutes`. Two main CI runs (#94 and #95) were cancelled at 360.3 minutes stuck in `npx playwright install --with-deps chromium webkit`. PR #107's Windows Ship drill was still in `hub:ship --drill-rollback` after 45+ minutes; that job normally finishes in about 2.5 minutes.

## Read first

- The 9 Nov 2026 measurement behind this note: of 13 completed red CI runs, the titles and counts in Why, above.
- The lead's merge notes for known flake titles (those notes are not in this repo).
- `tests/browser/agents-page.spec.ts` (line 23, the `w:d5` asserts after `move(page, "workerFailed")`; line 152, the width loop with `waitForTimeout(250)` and `PROBLEMS` inside the iframe).
- `tests/browser/video-preview.spec.ts` (metadata poll already 15 s, comment about cold WebKit).
- `tests/browser/workflow-run.spec.ts` (the "a Stop that fails comes back…" test, around line 75).
- `playwright.config.ts` (no `retries`).
- `src-tauri/src/stacks.rs` (`two_writers_do_not_lose_a_stack`), `src-tauri/src/attribution/tests.rs` ("git didn't answer"), `src-tauri/src/activity/tests.rs` (`two_connections_both_keep_their_rows`).
- `host/windows-bootstrap.test.ts` (`node.exe` in use by another process).
- `scripts/hub-ship.test.mjs` and `.github/workflows/ci.yml` (Ship drill job, Playwright install step, no timeouts).
- Earlier flake PRs for context only: #91 (ship EPERM rename), #90 (door port), #92 (finder names), #96 (door release / busy script). Do not reopen those unless they still fail.

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-153-ci-flakes.md`. Add `docs/hivra/work/FLAKY-TESTS.md` as the tracked list: each known title, OS/browser, last seen run id, suspected cause, and status (`fixed`, `retry`, `quarantined` with the issue note). Commit that first. Keep the list honest as you go.
2. **Find the root cause and fix, in this order.** Do not start with `test.skip` or a longer timeout.
   1. WebKit `agents-page.spec.ts:152`. The 250 ms sleep after a resize is the likely race (WebKit has not flushed layout in the iframe). Wait for a stable condition (`expect.poll` on `PROBLEMS`, or two animation frames plus a layout read), not a fixed sleep. Prove it: run the test in WebKit many times locally if you can, and explain the sequence in `PR.md`.
   2. WebKit `agents-page.spec.ts:23`. After `workerAsks` / `workerStuck` / `workerFailed`, `[data-list="attention"] [data-item="w:d5"]` is missing. Find whether the fixture did not apply, the iframe had not painted, or the row landed in another list. Fix the cause. Do not hide the missing row with a weaker assert.
   3. WebKit `video-preview.spec.ts:3`. Metadata or play on a cold WebKit pipeline. Prefer a deterministic ready wait or a retry of `play()` after metadata; do not just raise 15 s to 60 s.
   4. WebKit `workflow-run.spec.ts:75` "a Stop that fails comes back with the reason instead of Stopping… for good". Make the failed-stop path assert on a flushed UI state, not a single immediate read that can still say "Stopping…".
   5. Windows rust: `stacks::tests::two_writers_do_not_lose_a_stack`, `activity::tests::two_connections_both_keep_their_rows`, and attribution tests that fail with "git didn't answer" (`two_crews_installing_together_both_get_the_hook`, `a_crew_commit_carries_the_trailers_and_the_repo_hook_still_runs`). Likely tight git or file-lock timeouts under a loaded Windows runner. Retry only the transient OS error, with a bound, or fix the wait. Do not lengthen every rust test timeout.
   6. `host/windows-bootstrap.test.ts` sharing violation on `node.exe`. Serialise the step or retry on the well-known Windows file-lock error. Do not ignore other failures.
   7. Windows Ship drill hang / EPERM rename. A failure should finish in seconds, not hang. If `hub:ship --drill-rollback` can block on a rename, add a bound and a clear error. #91 already retried EPERM; if that is still the path, make the wait finite and obvious.
3. **If a root-cause fix is not reachable in this package,** add a deterministic retry, or quarantine with a tracked list entry and a short issue note in `FLAKY-TESTS.md`. Allowed fallbacks, in order: Playwright `retries: 1` on the `webkit` project only (not chromium, not a blanket skip); a bounded retry around a single Windows API that returns a known transient error. Never `test.skip` without the list entry. Never delete the test. Never weaken the assertion so a real bug would pass.
4. **CI timeouts** in `.github/workflows/ci.yml` (this is required even if every flake is fixed). Do not change `permissions:` or secrets. Suggested starting values, adjust only with evidence:
   - `browser` job: `timeout-minutes: 25` (tests are ~12 minutes; install should be under 5).
   - Playwright install step: `timeout-minutes: 8`.
   - `Ship drill` job: `timeout-minutes: 10` (Windows median 2.5 minutes).
   - `check` job: `timeout-minutes: 30` (macos max about 22).
   - `host` job: `timeout-minutes: 10`.
   - `rpm` job: `timeout-minutes: 25`.
   Leave a comment that 360 minutes is the platform default and is too long for a hang. WP-154 will add Playwright caching; do not build the cache here unless you must in order to attach the install-step timeout cleanly. Do not add path filters here (WP-154).
5. **Proof.** For each test you change, run it enough times to be honest (WebKit locally for the browser ones; scoped `cargo test` for the rust ones; `npx vitest run host/windows-bootstrap.test.ts` only if you can do it without touching a real Windows host you should not). Write the counts in `PR.md`. Do not run full `npm run check` or unfiltered `cargo test`. `npx tsc --noEmit` if TypeScript changed. `cargo fmt --check` and clippy if Rust changed.
6. **Out of scope.** Do not treat WP-105 harnessGuard failures as flakes. Do not change branch protection, required checks, or workflow permissions. Do not add paid runners. Do not skip the whole browser suite.

## Done when

- [ ] Each title in the known list is either fixed, retried deterministically, or quarantined with a line in `docs/hivra/work/FLAKY-TESTS.md`.
- [ ] `ci.yml` has job and Playwright-install / ship timeouts well under 6 hours.
- [ ] `PR.md` names the cause, the fix or fallback, and the proof you actually ran.
