# WP-163: Selective re-run of known flaky CI jobs

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| First Mate smoothness (Ash 10 Nov 00:14 UK) | S | WP-153 (flakes + timeouts), WP-155 helpful | yes |

## Goal

When a programme PR's CI fails only on jobs listed as known flakes (WP-153's tracked list), the lead tick (or a small script the tick calls) re-runs **those failed jobs once**, not the whole workflow, then waits again. Real failures still block.

## Why

Tonight's CoS lead re-ran only the failed flake jobs and saved 20 to 30 minute full re-runs. WP-153 fixes root causes and adds timeouts; WP-155 ships on green. Neither adds the selective re-run helper the lead used by hand.

## Read first

- WP-153 `FLAKY-TESTS.md` / tracked list once on main; `.github/workflows/ci.yml`.
- Existing Mac helpers for re-running failed jobs (patterns only; do not commit private paths).
- `gh run rerun --failed` behaviour; prefer job-level re-run when the API allows.

## Build

1. Docs to `docs/hivra/work/WP-163-selective-ci-rerun.md`.
2. `scripts/hivra-rerun-flakes.mjs`: input PR or run id; read failed jobs; if every failure matches the known-flake list (titles or job names from the tracked file in-repo), re-run failed only; otherwise exit non-zero with the real failure names. Dry-run default; `--apply` to call `gh`. Tests with fixtures.
3. Optional hook from WP-160 tick: one automatic attempt per PR head sha, then stop (no loops). Setting off by default until WP-153's list exists on main.
4. Out of scope: deleting tests, changing branch protection, Actions write tokens beyond existing `gh` auth, quarantining without WP-153b.

## Done when

- [ ] Only known-flake-only failures are re-run; mixed or real failures refuse.
- [ ] At most one auto re-run per head sha.
- [ ] Dry-run default; tests with fixtures pass.

## Licence

Product behaviour. No third-party copy.
