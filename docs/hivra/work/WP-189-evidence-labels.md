# WP-189: Evidence labels: what a task is, and what proves it

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | S | 40 | yes |

From PLAN.md, "From oh-my-hermes", item 4 (two-axis evidence labels). oh-my-hermes is MIT (read at commit `2676c33`);
idea only, credited per SOURCES.md.

## Goal

Every worker row, task card and goal-graph node carries one short label with two parts: the phase (Plan, Code, Test,
Review, Docs) and the proof ("not run", "reported done", "checked", "verified", "failed check"), for example
"Test · reported done" or "Code · verified". A worker saying it ran the tests can never read as tests verified.

## What Hivra has

- The five statuses (`FirstMateStatus` in `src/features/monos/model/delegations.ts`: working, needs-you, done, failed,
  paused; words in `src/features/crew/model/words.ts`, `statusWord`). They say where the work is, not what proves it.
- WP-40: `gateVerdict` on a delegation (`pending`, `passed`, `failed`, `unsure`; `gate_verdict` in
  `src-tauri/src/delegations.rs`), from `src-tauri/src/gates.rs` (`GateRun`) and `verify_stage.rs`, where a step that
  could not run is `couldNotExercise` or `notRun` and never a pass.
- The worker's typed report (`report`, `src/features/firstmate/model/report.ts`) and self-review.
- WP-91 goal graph tasks have `role` `build` or `verify` (`orchestrationState.ts`), drawn in `GoalGraph.tsx`.
- Crew rows (`src/features/crew/model/rows.ts`) and task cards (`src/features/tasks/ui/TaskDetail.tsx`).

## What to build

1. **One pure function** `evidenceLabel(input)` in `src/features/crew/model/evidence.ts`, from records only:
   - **Phase:** the brief's phase if the first mate set one (`delegate_task` gains an optional `phase`: plan, code,
     test, review, docs), else `verify` role gives Test, a read-only research worker gives Plan, otherwise Code.
   - **Proof**, strongest first: `failed check` when the gate verdict is `failed`; `verified` when it is `passed` and
     the verify stage passed for this head; `checked` when gates passed but no verify stage applies; `reported done`
     when the worker settled `completed` with no gate verdict, or the verdict is `pending` or `unsure`; `not run` when
     the worker has not settled. A worker's report text never raises the proof.
2. **Shown in three places,** each as plain text beside the status word, no chip: the crew row, the task card's
   delegation line, and the goal graph node. Same words everywhere (one exported word table, as `words.ts` does).
3. **The first mate reads it.** The worker summary a first mate receives on a wake carries the label, and the first
   mate contract (`src/features/firstmate/contract.md`) gets one sentence: report "reported done" as a claim, never as
   a result.

## Rules

- No new status. The five statuses stay the only states (SPEC section 4); the label is a description beside them.
- Derived in code from records, never from model prose.
- No new outward network call; no change to gates, verdicts, approvals or the protected-path list
  (`src/shared/security/agentConfigPaths.json`, when it exists).
- Credit oh-my-hermes (MIT) for the idea in the PR and update its row in SOURCES.md.
- Upstream rules from PLAN.md: a new file in `src/features/crew/model/`; the views get one-line hooks.

## Done when

- [ ] Red first: a table test of `evidenceLabel` over every combination of settled state, gate verdict and verify
      result, written before the function. Key rows: completed with no verdict is "reported done"; `unsure` is
      "reported done"; `passed` with a verify pass is "verified"; a report saying "all tests pass" with no verdict is
      still "reported done".
- [ ] Test: the wake summary carries the label.
- [ ] Browser spec `tests/browser/evidence-labels.spec.ts`: seeded workers show the label in the Crew tab, on a task
      card and on a goal graph node, with the same words. Screenshot in the PR.
- [ ] `npm run check` passes.

## Not in this package

New gates or checks. Changing how verdicts are computed (WP-40, WP-91).
