# WP-249: Check a "done" claim against the diff, not the worker's story

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | M | WP-40 | yes |

## Goal

A worker's "done, tests pass, only touched X" is believed only after the app has checked it against the actual diff
and re-run what it claims.

## Why

- fable-method's fable-judge (MIT, github.com/Sahir619/fable-method):
  1. lists the claims;
  2. takes `git diff` as the truth;
  3. re-runs every claimed check, and marks anything it can't re-run UNVERIFIABLE;
  4. hunts for weakened tests, false completion, scope creep, outward actions without an owner quote and leftover
     debris;
  5. answers VERIFIED, VERIFIED WITH CAVEATS or REFUTED, with a table of each claim and what was observed.
- Its evidence is thin (two runs per model on one fixture), so build the cheap code checks first.
- rightcommit (Apache-2.0) records the exact tree a verdict passed on, and a new version cancels older approvals.
- Today the WP-40 verdict is a cheap model with no tools that reads the worker's report in full.
- Research: `/mnt/project-files/hivra-research/reports/nov11-proof-and-review.md`.

## Build

1. Code checks before any model:
   - "only touched X" against the diff's file list;
   - a test file whose asserts were removed or skipped;
   - debris (`.orig` files, logs, `console.log` added);
   - outward actions (push, PR, post) with no Ash quote.
2. The verdict model gets a list of the claims and the diff, not the report's wording. It answers in the three
   verdicts, with a table of claims.
3. Store the tree hash the verdict passed on. Accept or delivery re-checks it, so a later change voids the verdict.
4. Copy fable-method's fake-work fixture, with credit, as an acceptance test. It must come back REFUTED with all
   five planted frauds named.

## Done when

- [ ] Tests for each code check, the voided verdict and the fixture.
- [ ] Credits for the fixture.
