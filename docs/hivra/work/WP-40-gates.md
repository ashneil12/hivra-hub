# WP-40: Completion and verdict gates

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | M | 10 | no |

## Goal

A worker's "done" becomes **done** only after code checks it: there is a change, the project's checks pass, the
work is committed, and a cheap check confirms the brief was actually met.

## Why

SPEC.md section 4, step 6, and principle 4. Puppetmaster's non-bypassable gates, Raven's "finished is not
succeeded", pstack's verification skills. The Hub already has most of the parts.

## Read first

- `src-tauri/src/gates.rs` (per-project check scripts the app runs when a worker reports done, kept where workers
  can't edit them), `src-tauri/src/verify_stage.rs` (runs the project's own checks and a real-path recipe; a step
  that couldn't run is never a pass), `src-tauri/src/project_file.rs` and `.monocode/project.json` (the Check
  action), `src-tauri/src/land.rs`.
- Puppetmaster's gates (`require_diff`, `command`, `committed`, `ratchet`) and its typed artifacts (MIT).
- Raven's verdict gate (`raven/agent/subagent/dag_verdict.py`, `dag_adjudication.py`; Apache-2.0, ideas).

## Build

1. **Gates per brief**, chosen by the first mate from a fixed set, with project defaults: `diff` (something
   changed), `checks` (the project's Check action or named commands pass, run by the app in the worker's copy
   through `verify_stage.rs`), `committed` (no uncommitted leftovers), `ratchet` (test count doesn't drop), and
   `routes` (today's `gates.rs` scripts). A brief that changes code always gets `diff` and `checks`.
2. **Run them in code** when a worker reports done. A failed gate fails the task with the output in plain words; the
   worker gets one fix round, then its first mate decides. A gate that couldn't run is recorded as not run, never
   as passed.
3. **Verdict check**: after the gates pass, a cheap model (WP-13's role model) compares the worker's report and
   diff with the brief's definition of done and answers met, not met (with why) or unsure. Not met counts as a
   failed gate; unsure goes to the first mate.
4. `derive_status` (WP-10) returns done only when every gate passed and the verdict is met.
5. Evidence (commands, exit codes, output tails, the verdict) is stored on the delegation row and shown in the
   Crew tab (WP-15) and the PR body (WP-12).

## Done when

- [ ] Tests: each gate passing and failing; a gate that can't run is not a pass; one fix round then escalation;
      verdict met, not met and unsure (fake model).
- [ ] `hub:verify-live` still passes; `npm run check` passes.
