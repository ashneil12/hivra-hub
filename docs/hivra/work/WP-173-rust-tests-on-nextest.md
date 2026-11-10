# WP-173: Rust tests on nextest (per-test retry once, per-test hang limit, flaky list in the job summary)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Overnight alpha hunt (10 Nov 02:00 run), pipeline speed | S-M | Start after WP-154 (#129, ci.yml) merges. Read WP-153b's state first (FLAKY-TESTS.md). Does not touch test bodies. | yes |

## Goal

Run Hivra's Rust tests in CI with cargo-nextest instead of plain `cargo test`, so that:

1. A Rust test that fails once is retried once **by itself** (not the whole 20-30 minute job). If it then passes it is reported as FLAKY, does not block, and is listed by name in the job summary, marked "already on FLAKY-TESTS.md" or "new, add to FLAKY-TESTS.md". A test that fails twice still fails the job. This is Ash's rule from 9 Nov 23:24: retry once, quarantine only temporarily, real failures still block.
2. A Rust test that hangs is stopped after a fixed limit with its name, instead of eating the job's 30-minute timeout.
3. The Rust step gets faster or at least no slower. Measured, not assumed.
4. The redundant `cargo check` after `cargo clippy --workspace --all-targets` is dropped (clippy already type-checks every target).

## Why

Pipeline speed is Ash's top builder priority. Tonight's lead notes show Rust flakes still costing whole-job reruns after WP-153: Windows `attribution::git::tests::a_rejected_command_is_not_tried_again` (main regression, hotfix #139), `attribution::tests::two_crews_installing_together_both_get_the_hook` seen again despite #119's in-test retries. Each forced `gh run rerun --failed` costs another 20-30 minutes. Today the only Rust retry mechanism is hand-written retries inside individual tests (WP-153), and the only way to learn a Rust test is flaky is a human reading logs.

cargo-nextest (https://github.com/nextest-rs/nextest, Apache-2.0 / MIT, 3.4k stars, release cargo-nextest-0.9.151 on 3 Nov 2026) does this natively: `retries` with per-test overrides, a FLAKY result when a retry passes (treated as pass by default, `flaky-result = "fail"` available), `slow-timeout` with `terminate-after` for hangs, JUnit output that marks flaky and rerun-failed tests, and process-per-test isolation (tests that share process-global state stop interfering). Docs: https://nexte.st/docs/features/retries/ . Hivra has about 2,200 Rust tests in `src-tauri` + `crates/mobile-link`.

Current `ci.yml` rust steps (origin/main 61ffbd54): `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo check`, `cargo test`. On WP-154's branch the macOS `all` job runs web and Rust through `scripts/ci-check-parallel.mjs`; Linux and Windows have separate `rust` parts.

## Read first

- Hivra `origin/main` after WP-154 merges: `.github/workflows/ci.yml` (`check` job, `rust` and `all` parts), `scripts/ci-check-parallel.mjs`, `package.json` (`check:rust`), `docs/hivra/work/FLAKY-TESTS.md`, WP-153b's branch if it is still open (`wp/153b-quarantine-rewrite`), WP-163's branch (`wp/163-selective-ci-rerun`) so the job summary and rerun logic do not fight.
- nextest docs: retries and flaky tests, slow tests and timeouts, JUnit support, `.config/nextest.toml` profiles, and "nextest does not run doctests" (keep a `cargo test --doc` step if any doctests exist).

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-173-rust-tests-on-nextest.md`. Add a `docs/hivra/SOURCES.md` row for nextest (tool used in CI, Apache-2.0 / MIT; no code copied, so no credits.json entry unless a config file is copied verbatim).
2. **Config.** Add `.config/nextest.toml` with a `ci` profile: `retries = 1`, `flaky-result = "pass"`, `slow-timeout = { period = "60s", terminate-after = 3 }` (a hung test is killed at about 3 minutes), `fail-fast = false`, JUnit to `target/nextest/ci/junit.xml`. Leave the `default` profile so a developer's local `cargo nextest run` behaves like `cargo test` (no retries). Short comment block saying why each value is what it is.
3. **CI steps.** In the `rust` parts (Linux, Windows) and the Rust half of the macOS `all` part: install nextest with a pinned action (`taiki-e/install-action` pinned to a full commit SHA, `tool: cargo-nextest`) or the pinned prebuilt binary; no new permissions, no secrets, no tokens. Replace `cargo test` with `cargo nextest run --workspace --profile ci`, then `cargo test --doc --workspace` only if the workspace has doctests (check, and say which in PR.md). Remove the standalone `cargo check` step (clippy `--all-targets` covers it). Keep `cargo fmt --check` and clippy unchanged. Keep `package.json` `check:rust` working for people without nextest (do not make nextest a local requirement).
4. **Flaky summary.** Add `scripts/ci-rust-flaky-summary.mjs` (plain Node, no deps) that reads the JUnit file and writes to `$GITHUB_STEP_SUMMARY`: tests that were flaky (failed then passed), each marked "on FLAKY-TESTS.md" or "new: add to FLAKY-TESTS.md"; tests that failed twice. It never changes the job result. Upload the JUnit file as an artifact (`if: always()`, short retention). Unit tests for the parser with small JUnit fixtures (flaky, failed twice, clean, missing file) under the existing `check:scripts` runner.
5. **Measure.** In PR.md, give the Rust step wall time before (main's last 5 green runs per OS, from `gh run view --json jobs`, if the builder can read them; otherwise leave a table for the lead) and after (this PR's CI). If nextest is slower on an OS by more than 10%, keep `cargo test` on that OS only and say so; retries and the summary still apply where nextest runs.
6. **Out of scope.** No change to test bodies or WP-153's in-test retries (WP-153b owns rewrites). No quarantine list file other than FLAKY-TESTS.md. No browser/vitest changes. No self-hosted runners, paid runners, new secrets or workflow permission changes. No automatic edit of FLAKY-TESTS.md by CI.

## Done when

- [ ] CI Rust tests run through nextest on every OS where it is not slower; a single flaky failure no longer fails the job, a double failure still does.
- [ ] A hung Rust test is named and stopped in about 3 minutes.
- [ ] The job summary lists flaky and twice-failed Rust tests and says whether each is on FLAKY-TESTS.md.
- [ ] The redundant `cargo check` step is gone; fmt and clippy unchanged.
- [ ] Parser tests pass under `npm run check:scripts`; PR.md has the before/after timing table.

## Licence

nextest is Apache-2.0 / MIT (dual). Used as a CI tool; no code copied.
