# WP-154: Make CI's typical run short, and cut the long tail

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Pipeline speed (9 Nov 22:11 UK) | M | Prefer after WP-153 if both edit `ci.yml`; otherwise parallel | yes |

## Goal

A normal PR's CI finishes around 12-18 minutes, the 60-70 minute tail caused by Playwright install goes away, docs-only changes do not build two RPM images, and a merge to main does not start Native Preview unless native files changed.

## Why

Measured 9 Nov 2026 22:12-22:22 UK. On 31 typical CI runs, median wall was 47 minutes and mean 45. If Playwright install had been capped or cached at 3 minutes, median wall would have been 19.4 minutes (mean saving 18 minutes). 19 of 135 browser-job installs took 15-60 minutes; two hit the 6-hour default. When install is fast, the ceiling is `check (macos-latest, all)` at median 17.8 minutes, because `npm test` (8.2) and `cargo test` (5.2) run one after the other on the same runner. Splitting that job into two macOS runners would fight the free tier's 5 macOS slots. Running those two halves in parallel inside the same job does not.

RPM fedora:43 and almalinux:10 take about 13 minutes each on every PR, including docs-only. AppImage already skips when packaging files are unchanged. Native Preview's pull_request event has path filters; **push to main does not**, so every merge starts two more macOS jobs (Native macOS median 26.6 minutes) and fills the 5-slot cap with CI's three macOS jobs. Observed macOS queue p90 is 8-9 minutes, max 20-21.

Already in place, do not redo: `concurrency` + `cancel-in-progress`, npm cache (`npm ci` median 0.2 minutes), rust-cache, browser 4-way shard, Windows web 2-way shard, Linux/Windows web and rust already split, draft PRs skipped.

## Read first

- This folder's `REPORT.md`.
- `.github/workflows/ci.yml` and `.github/workflows/native.yml`.
- The AppImage "Skip unless packaging files changed" step in `ci.yml` (copy that idea for RPM, do not invent a new permission model).
- Playwright version is `^1.63.0` in `package.json`. Cache key must include the resolved version (hash of `package-lock.json` is fine).

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-154-ci-speed.md`. Commit that first. If WP-153 has not merged and you need its `timeout-minutes` to land with the cache work, merge `origin/main` and, if still missing, include the same timeout values WP-153 specified rather than leaving hangs in place. Do not fight WP-153's test fixes; do not edit the flake specs here.
2. **Cache Playwright browsers.** In the `browser` job, cache `~/.cache/ms-playwright` with `actions/cache@v4`, keyed on runner OS plus `package-lock.json` (or the Playwright version from the lockfile). On a cache hit, install OS deps only (`npx playwright install-deps chromium webkit` or the equivalent that does not re-download browsers). On a miss, run `npx playwright install --with-deps chromium webkit`. Put `timeout-minutes: 8` on that install step if WP-153 has not already, and retry the step once on failure if GitHub Actions lets you do that in a few lines without a new action that needs extra permissions. Do not add a marketplace action that wants `pull-requests: write` or secrets.
3. **Path filters.**
   - Skip `rpm` and `rpm-clean-install` unless packaging or rust/linux ship inputs changed, using the same style of base-sha diff as AppImage (or a job-level `paths` filter if you can do it without skipping those jobs when they really need to run). Files that should still trigger RPM: Fedora/Alma install scripts, `package.json` / `package-lock.json`, `Cargo.lock`, `src-tauri` packaging config, the RPM job itself.
   - In `.github/workflows/native.yml`, apply the existing pull_request `paths:` list to `push:` as well, so a merge that only touches the Tauri app, docs, or credits does not start Native Preview. Keep `workflow_dispatch`.
   - Optional and only if cheap: skip `mobile` when `mobile/**` and its workflow inputs are unchanged. Do not skip `check`, `browser`, `host`, or `ship` for ordinary app PRs.
4. **Parallelise macos check in one job.** For `matrix.os == macos-latest && matrix.part == all`, run the web steps (`npm test`, `tsc`) and the rust steps (`cargo fmt`, clippy, `cargo check`, `cargo test`) concurrently in one job, fail the job if either half fails, and keep logs readable (named log groups or two scripts writing to files that you then print). Do not add a second macos runner. Leave Linux and Windows as they are (already split).
5. **Rebalance browser shards.** Shards 1 and 3 take about 10 minutes of tests, shards 2 and 4 about 4. If Playwright's hash split stays uneven, a documented file list or `--shard` alternative that evens them is worth a few minutes off the browser path. This is secondary to the install cache and the macos parallelisation; skip it if it needs a fragile hand-maintained list.
6. **Out of scope.** No paid runners, no new accounts, no changes to `permissions:`, no secrets, no required-check / branch-protection edits. Do not remove rust-cache or npm cache. Do not run the full browser suite twice. Do not fold Native Preview into CI.

## Done when

- [ ] Browser jobs use a Playwright browser cache and an install-step timeout.
- [ ] RPM is skipped for unrelated PRs; Native Preview is skipped on main pushes that do not touch native paths.
- [ ] macos `check` runs web and rust at the same time on one runner.
- [ ] `PR.md` cites the measured before numbers from `REPORT.md` and what you expect after, without claiming a speedup you did not reason from those numbers.
