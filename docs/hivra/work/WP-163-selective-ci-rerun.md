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

## How the lead re-runs

Dry-run is the default. It reads the latest CI run for the pull request head and prints the command. It does not re-run anything.

```sh
node scripts/hivra-rerun-flakes.mjs 123
```

Re-run only the failed jobs when every failure is on the known flake list:

```sh
node scripts/hivra-rerun-flakes.mjs --apply 123
```

A run id instead of a pull request:

```sh
node scripts/hivra-rerun-flakes.mjs --run 42706613294
```

From outside a checkout, pass the repo as well:

```sh
node scripts/hivra-rerun-flakes.mjs --repo OWNER/NAME --apply 123
```

The command it prints and, with `--apply`, runs is:

```sh
gh run rerun RUN_ID --repo OWNER/NAME --failed
```

That is GitHub's failed-job re-run. It does not re-run jobs that passed and it does not start the whole workflow. If any failed job is not on the list in `docs/hivra/work/FLAKY-TESTS.md`, the script exits non-zero and prints that failure's name. It does not call `gh run rerun`.

A job named on the list (the Windows ship drill) is re-run only when its log shows no failing test of its own. A named test has to be on the list itself. The same file with a different title does not match. Rows marked fixed still count: a listed title that fails again is still a known flake.

`ci-ok` is the rollup job. It fails when another job fails, so it is not treated as a separate failure in that case. If it is the only failed job, that is a real failure and the script does not re-run.

A missing list, a run that is still going, a cancelled run, or `gh` not answering is not treated as a flake failure. The script uses the `gh` login already on the machine. It does not take a new token and it does not change workflow permissions.

Automatic re-run is off. A tick turns it on with `HIVRA_RERUN_FLAKES_AUTO=1` and:

```sh
node scripts/hivra-rerun-flakes.mjs --auto --state DIR 123
```

That makes one attempt for that head sha and records it in `DIR`. A later tick for the same sha does not re-run. A different sha can. A green run, a real failure, or a run that is not finished does not use up the attempt. `--apply` by hand is not limited and does not write that record.

## Done when

- [x] Only known-flake-only failures are re-run; mixed or real failures refuse.
- [x] At most one auto re-run per head sha.
- [x] Dry-run default; tests with fixtures pass.

## Licence

Product behaviour. No third-party copy.
