# WP-91: The goal graph: a finish line proved first, and a live view of the run

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| K | L | 14, 40, 82 | yes |

## Goal

When a first mate (or any project Lead) starts a big orchestration run, the run is a goal, not just a list of jobs.
Before any worker starts, the goal's finish-line check is run in the lead's checkout and its failure is recorded as the
baseline. The plan is refused if two tasks that can run at once write the same file. Every worker hands back a short
handoff file, and a task is accepted only when that file exists and its changes have been integrated. A failed task gets
a repair task, and only its downstream waits. The run ends with a verify task, and the app itself runs the finish-line
check in the integrated checkout; the run is done only when that check passes and every task is accepted with its gates
met. The whole graph, with its layers, states, repairs and verify node, is live on screen.

## Why

Ash, 5 Nov: he shared [oh-my-hermes](https://github.com/rlaope/oh-my-hermes) (MIT, read at commit `2676c33`) and asked
for Hivra's way of running big work to be the best one. Its graph planner, dag-ulw, is the part worth the close look.
Ash listed eight claims worth checking; the code behind them is uneven, and Hivra's orchestration run already matches
it on most of them:

| # | dag-ulw's point | Hivra today | Verdict |
| --- | --- | --- | --- |
| 1 | A finish-line check that can fail is written before any work | A delegation requires a `goal` ("the condition that finishes the job, as a check someone can run", `src-tauri/src/mcp_server.rs:214`), and the brief's gate plan (`diff`, `checks`, …) is resolved and stored before the worker runs (`src-tauri/src/firstmate/gates.rs:110-141`). But the goal is prose: nothing runs it first and nothing proves it can fail. dag-ulw requires a `VERIFY` line in every node prompt (`dag_run.py:118`) and a `baseline` role (`dag_run.py:129`), and still never runs the suite itself. | **Partly.** The check exists; the red proof and the baseline do not. |
| 2 | Each node has its own context and write scope, so parallel nodes never touch the same file | An orchestration task requires project-relative `files` (`src/features/orchestration/model/orchestrationPlan.ts:192-202`), overlapping scopes are compared with one path key (`orchestration.ts:147-153`), a queued task that overlaps a running one waits (`orchestration.ts:1506-1512`), each worker has its own checkout (`orchestration.ts:1286-1298`), and a reported write outside the scope stops that worker only (`orchestration.ts:2209-2257`). On the shared first-mate path `isolation` defaults to `shared` and `files` is a wait heuristic (`mcp_server.rs:218`, `src/features/firstmate/model/workerPool.ts:655-749`). | **Has** for orchestration runs. dag-ulw's runtime hook blocks a write before it happens; Hivra contains it in the worker's checkout and refuses it at integration. |
| 3 | Ready nodes are dispatched in parallel, layer by layer | The pump starts every queued task whose `dependsOn` are all accepted, up to `maxWorkers` 1–4, skipping scope overlaps (`orchestration.ts:1486-1554`); the first-mate engine runs up to `MAX_FANOUT = 8` (`src-tauri/src/firstmate/mod.rs:42-65`). Layers are not computed: readiness is the dependency frontier, exactly as in dag-ulw, where "a layer orders, it never gates" (`dag_core.py:20`). | **Has.** Only the presentation is missing. |
| 4 | A node is accepted only after its handoff file is read | `review` is the only acceptance, refuses anything not completed, integrates the worker's checkout, and only then marks it accepted (`orchestration.ts:1273-1323`). The delegation path has a read receipt: reading a result with `task_status` marks it read (`mcp_server.rs:238`). Orchestration's `review` has neither a read receipt nor a handoff file; a Lead can call it without opening the result. dag-ulw refuses acceptance with `handoff_missing` when no file exists (`dag_run.py:1411-1418`), which proves existence, not reading. | **Partly.** Integration is stronger than a claim; the handoff and the receipt are missing. |
| 5 | A failed node gets a repair node, and only its downstream waits | Failure is contained: a dependent stays queued until its upstream is accepted (`orchestration.ts:1498-1505`) and independent tasks keep running. Repair exists as `message`, `retry` with a corrected scope, and `redoes`, which takes over a failed task's own checkout (`orchestration.ts:1126-1204`, `mcp_server.rs:227`). There is no repair node and no second-cycle re-plan. dag-ulw adds a node with `origin: repair:<root>`, two cycles, the second a re-plan (`dag_run.py:1451-1504`, `MAX_REPAIR_CYCLES = 2`, `REPLAN_CYCLE = 2`). | **Partly.** Repair works; it is invisible and capped only by the lead's judgment. |
| 6 | A separate verify node runs the real suite at the end, never the builder | The app runs each worker's gates, including the project's own checks, in the worker's copy (`firstmate/gates.rs`, `src-tauri/src/verify_stage.rs`; a step that could not run is never a pass). WP-81 is one independent review before GitHub. But `finish` runs no suite (`orchestration.ts:1365-1435`), and the final validation task is a prompt instruction the model may omit (`orchestrationPlan.ts:247`). dag-ulw requires a verify node as a role string and never runs the suite; its verdict only checks that every producer is an ancestor of an accepted verify node (`dag_run.py:851-891`). | **Partly.** The independent runner exists per task; the run-level verify node and verdict do not. |
| 7 | Irreversible steps wait for approve or send back | People approve at the merge and delivery boundary (`src-tauri/src/delivery/mod.rs`; checks red, open decisions and the project's yolo switch), WP-81 parks judgment calls as WP-14 decisions, and a worker can't commit or push. But an irreversible inner step (a migration against a shared database, a provider call that spends money) has no declaration or approval of its own: the lead approves it, not the person. dag-ulw has no code for this at all, only a sentence in its skill asking for an `Authorize` question. | **Partly.** The gates exist at delivery; the per-step gate does not. |
| 8 | The live graph view | Live worker rows and a tree under the lead exist (`src/features/orchestration/ui/OrchestrationSidebarAgents.tsx:22-42`), and the plan card lists dependencies as text ("After · …", `OrchestrationPreview.tsx:689-700`). There is no node-and-edge graph. | **Partly.** Live state yes; the graph no. |

So four of the eight (2, 3, 4, 5) are already there in a different, sometimes stronger, form; the rest are real gaps.
This package adds only those, and adds them to the run Hivra already has rather than to a second scheduler.

**Worktrees, compared.** dag-ulw runs every node in one workspace and holds them apart with a write-scope hook before
each write; no node gets its own worktree. Hivra gives each orchestration node its own git worktree, a treehouse pool
slot once WP-82 lands, and applies its changes to the lead only on acceptance. That is a stronger boundary than file
exclusion, and it is why this package does not copy dag-ulw's pre-write hook: an out-of-scope write stays in the node's
checkout and is refused at integration. Per-crew first-mate worktrees are the same boundary one level down; their
`files` wait is a heuristic and stays as it is. WP-91 brings dag-ulw's plan-time scope check, not a third isolation
model, and takes the pool slot from WP-82 like every other crew.

**How it sits on the first mate and crews.** The first mate (or a project Lead) chooses an orchestration run for work
big enough to need one; a small brief still goes straight to a worker. Each node is still a crew: a worker chat with
the existing brief template, its own checkout, its model and effort, and WP-40's gates. The lead still accepts each
node with `review` and still reports to its first mate; the run verdict feeds `derive_status`, so a run reads done only
when WP-40's per-task result and the run's own check both agree. The person sees the run on the same card; only
irreversible steps and WP-81's judgment calls reach them. With WP-82 each node's checkout comes from the pool, with
WP-84 the design document supplies the goal and the check, and with WP-14 the irreversible approval is one decision.

## Read first

- oh-my-hermes at `2676c33`: `src/plugin_bundle/omh/dag_core.py` (topology, layers, `shared_scope_pairs`, `_scope_path`),
  `dag_run.py` (the record, `new_record`, `_require_graph`, `settle`, `repair`, `goal_verdict`, `lint`, the limits at
  lines 85-129), `src/skills/dag_ulw_skill.py` (the contract in words), and the tests `test_dag_core.py`,
  `test_dag_run_rules.py`, `test_dag_scope_guard.py`, `test_dag_replan.py`. Its `tools/dag_tool.py` and TUI
  (`src/tui/dag_tree.py`, `dag_pager.py`, `dag_block.py`) are read for the contract and the view, not copied.
- Hivra: `src/features/orchestration/model/orchestration.ts` (`pump`, `review`, `finish`, `delegate`, `retry`, the
  handoff envelope), `orchestrationPlan.ts` (the proposal schema and its validation), `orchestrationState.ts`,
  `ui/OrchestrationPreview.tsx` and `ui/OrchestrationSidebarAgents.tsx`, `src-tauri/src/control_cli.rs` (the `control`
  actions), `src-tauri/src/firstmate/gates.rs` and `src-tauri/src/verify_stage.rs` (the app-run checks), WP-40, WP-81,
  WP-82, WP-84, WP-14, `src-tauri/src/decisions.rs`, `src-tauri/src/autopilot.rs`, `crate::fs::canonical`.

## Build

1. **The goal and the finish line, before work.** Extend the proposal schema with `goal` (one line) and `check`
   (`command`, `expectExit`, and an optional `expectText`), and store both on the run. When a run starts, run the check
   once in the lead's checkout through `verify_stage.rs`, with the project-actions environment scrub, a timeout and
   capped output. If it exits as expected on the untouched base, refuse the run and ask for a check that can fail; if
   it times out or cannot start, record "not run" and refuse, never a pass. Otherwise store the failing output as the
   baseline. Also store a baseline for each named project check, so a failure that was there before the run is not
   counted as the worker's (dag-ulw's `baseline` role, as data rather than a model turn). Values from the proposal are
   untrusted: validate lengths and types, never interpolate them into a shell, and fall back to refusal.
2. **The graph is checked when the plan is approved.** Translate `dag_core.py` (209 lines, pure stdlib) to
   `src-tauri/src/goal_graph/topology.rs`: `edge_problem`, `layer_of`, `layers`, `ready`, `critical_path`,
   `bottlenecks`, `_scope_path` and `shared_scope_pairs`, with its tests ported from `test_dag_core.py`. Reuse
   `orchestrationPlan.ts`'s scope normaliser; there is one, not two. When a proposal is validated, refuse it if two
   tasks that can run at the same time share a write scope (name up to 20 pairs), and say the fix: add a dependency, or
   change the scope. Keep the dispatch-time overlap check as the second guard, because `delegate` can add tasks after
   the plan.
3. **A handoff for every node.** The worker envelope already tells a worker what to do and report; add a named handoff
   file inside its checkout (`.hivra/handoff/<taskId>.md`) with four headings: Changed, Files, Checked (the command and
   its result), Left. `review` refuses acceptance when the file is missing, and records its canonical path and hash on
   the task. A downstream node's prompt names its predecessors' handoff paths, never their contents. The delegation
   path keeps its `task_status` read receipt; orchestration's `review` gains the same idea as "the handoff was read",
   recorded when the lead opens it before accepting. The app cannot prove the author was honest; it can prove the file
   exists, is inside the checkout, and was opened.
4. **A repair task, not a silent retry.** When a task fails, or its gates fail, a `repair` action creates a new task
   with `repairs: <failed id>`, the failed task's files, and a dependency on the failed task's accepted dependencies
   only. It takes the failed task's checkout (`redoes` already does this) or a fresh one. Two cycles per failed task;
   the second is a re-plan that may add nodes, at most two extend rounds per run. Only the failed task's downstream
   waits, as today. This extends `control_cli`'s actions; no second delegation tool.
5. **The verify task and the run verdict.** A proposal must contain exactly one task with `role: "verify"`, depending on
   every task that writes (a producer). The lead cannot finish until it is accepted with its handoff and the app itself
   has run the finish-line check in the integrated lead checkout after the last acceptance. The verdict is computed from
   the record, not from any agent's words: `verified` when every task is accepted, every gate passed, the verify task is
   accepted with its handoff, and the app's run of the check passes; `failed` when a check or a gate fails; `unverified`
   otherwise, with the reasons (no verify task, verify open, handoff unread, check not run). WP-40's per-task gates
   still decide each task; the run check is the goal. When WP-81's gate runs the same command, record which layer ran
   it once, as WP-81 build 9 already asks.
6. **Irreversible steps.** A task may be marked `irreversible` with a one-line reason. Before its first dispatch it
   parks as a WP-14 decision (Approve, or Send back with the person's words); an unanswered decision means that part
   does not start. Send back returns to the lead as a failed task with the steering attached. Autopilot may not answer
   this kind of decision automatically (`autopilot.rs`'s red list and the person's control stand). This is a field on
   the node, not a sentence a model may skip.
7. **The live graph.** One new component under `src/features/orchestration/ui/` (for example `GoalGraph.tsx`) reading
   the existing `orchestrator` store, with no second store: the goal and its check at the top with the baseline and the
   latest run result; layers as rows; each node's state glyph, model and handoff; repair and extend edges drawn under
   the node they came from; the verify node marked. A small graph opens fully; a big one folds quiet layers, then quiet
   nodes, and the person's folds win, as the live worker tree already does. It replaces the "After ·" text in
   `OrchestrationPreview.tsx` and extends `OrchestrationSidebarAgents.tsx`'s rows; it is not a new page. A saved run
   still draws after a reload.
8. **Safety and edge cases.** State that changes while work runs: the run record is written through the existing
   compare-and-swap `commit`, so a late accept, a cancel, a repair and a second window writing the same run can never
   overwrite each other blindly; a late result after a cancel changes nothing. A handoff path is canonicalised with
   `crate::fs::canonical` and refused unless it is inside the worker's checkout; a `..`, an absolute path, a Windows
   path and CRLF are normalised or refused by the one scope helper. The check command runs with an allow-listed
   environment (no secrets), a timeout, and capped output; an unreachable service or a timeout is "not run", not a
   final failure. Empty, duplicate and missing inputs (a node with no scope, two verify nodes, a check with no command,
   duplicate ids) are refused with plain words.
9. **Dev copies and Windows.** A dev copy keeps its run record in its own data folder and runs checks in its own
   checkout; it never runs the daily app's project checks. The topology and scope tests run on Windows; the handoff
   containment test uses the path helper and covers a drive letter and backslashes.

## What it replaces or extends, so nothing stacks

- **Orchestration run** (upstream): new fields and two actions (`repair`, `approve`), not a second scheduler. The pump,
  the review/integration path and the run record stay the only ones.
- **WP-40**: the run check reuses `verify_stage.rs` and the checks gate; the verdict reuses WP-40's verdict model and
  `derive_status`. No second check runner, and no second idea of "done".
- **WP-81**: the run's verify task hands to the delivery gate. With the gate on, the project's check runs once and the
  record says which layer ran it. WP-91 adds no second review.
- **WP-82**: a node's checkout is a pool slot, exactly as today's orchestration worktree will become one. No third
  worktree model.
- **WP-84**: the design document supplies the goal and the check, and its phases are still sequential runs, not graph
  nodes to re-run.
- **WP-14 and autopilot**: the irreversible approval is one decision with a stable key, answered only by the person.
- **First-mate briefs**: unchanged. A node's brief is still the brief template; the handoff adds a report shape.

## Copy with credit

oh-my-hermes is MIT (Copyright (c) 2026 oh-my-hermes contributors), read at `2676c33`. The licence header and the
`credits.json` component stay with the code; the `NOTICE` entry is added in the PR that copies the code, not before.

- **Translate, line by line:** `src/plugin_bundle/omh/dag_core.py` (209 lines, pure standard library) to
  `src-tauri/src/goal_graph/topology.rs`; and the record rules in `dag_run.py` (validation, `settle`'s handoff refusal,
  repair caps and the re-plan cycle, `goal_verdict`, `lint`) to `src-tauri/src/goal_graph/run.rs`. Port
  `test_dag_core.py` and the relevant cases of `test_dag_run_rules.py`; the scope normaliser's cases come from
  `test_dag_scope_guard.py`.
- **Read, not copied:** `tools/dag_tool.py`, `dag_scope_guard.py` and `dag_define_gate.py` are the Hermes hooks for a
  single-workspace model Hivra does not have; `src/tui/dag_tree.py`, `dag_pager.py` and `dag_block.py` inform the view's
  folding and wording only; `src/skills/dag_ulw_skill.py` informs the contract.
- **Why translation and not the package:** it is Python, and the run record must be Hivra's existing orchestration
  record rather than a second one beside it.
- `docs/hivra/credits.json` already lists this component as planned ("Planned for WP-91, code not copied yet"). The
  PR that copies the code fills it in and adds the `NOTICE` block, naming the two translated files and the commit.

## Honest limits

- A finish-line check can be the wrong check: it can pass without covering the goal. The verdict model reads the goal
  and the diff as WP-40 already does, and the person can write a better check on the card; the app cannot know the
  check is sufficient.
- A handoff proves a file exists and was opened, not that its author was honest. Hivra's acceptance also integrates
  the actual diff, which is the stronger evidence, and WP-40's gates read the code.
- Scope exclusion still cannot see a shell command that writes outside its declared files. Hivra contains it in the
  node's checkout and refuses it at integration; it does not claim to prevent it.
- dag-ulw's verify role is a declarative string and its code never runs the suite. This package's app-run check is
  stronger, but only as strong as the command.
- Repair and extend are initiated by the lead, as they are in dag-ulw by the parent; the code caps them and draws them,
  it does not decide the work.

## Done when

- [ ] Tests, first:
  - the finish line: a failing command is stored as the baseline with its output; a command that passes on the base is
    refused; a missing command, an empty command and a command that times out are refused or "not run", never a pass;
  - topology: unknown and self dependencies, a cycle, layers, readiness, critical path, bottlenecks, and two nodes that
    can run at once with overlapping scopes (including `..`, a trailing slash, a glob, a Windows path and CRLF) are
    refused or reported; `test_dag_core.py`'s cases are ported;
  - plan-time scopes: a plan with two concurrent overlapping tasks is refused and names the pairs; adding a dependency
    fixes it; a task added by `delegate` after the plan is still caught at dispatch;
  - handoff: a missing handoff refuses acceptance; a handoff outside the checkout is refused; a handoff inside is
    recorded with its hash and shown; a downstream prompt names it without pasting it;
  - repair: a repair node may depend only on accepted nodes or its own failed root; two cycles then a re-plan; an
    independent branch keeps running; a repair after a cancel changes nothing;
  - verdict: verified only with every task accepted, gates passed, the verify task accepted with its handoff and the
    app's check green; a red check, an open verify task, an unread handoff and a gate failure each produce their own
    reason; a baseline failure that stays failing is not green;
  - irreversible: parked before any process or checkout is made; approve dispatches; send back returns with the
    person's words; autopilot cannot approve; an ordinary task is not parked.
- [ ] Browser specs (Chromium and WebKit): a live run draws its layers and node states; a repair and a verify edge are
  visible; a settling task updates without a reload; a reload redraws a saved run; a big graph folds quiet layers and
  the person's folds win.
- [ ] WP-40's gate tests, WP-81's gate tests and WP-82's pool tests still pass; the project's check runs once per
  delivery and the record says which layer ran it.
- [ ] `npm run check` passes.
- [ ] Dev-copy check with `scripts/fake-claude.mjs`: a run whose check is red on the base turns green, one task fails
  and is repaired, one irreversible task waits for a decision, and the graph shows all of it.

## Addendum (10 Nov 2026): the run goal reaches every node's brief

Source: Paperclip (MIT, Copyright (c) 2025 Paperclip AI). Ideas only, no code or text copied.

Each node's brief names the run goal as its intent and gives the node's own line from the plan (title and layer), so a worker sees why, not only its title. Brief template only; there is no second goals store. Today `src/features/firstmate/model/brief.ts` keeps intent, spec and goal only, so no parent chain or run goal reaches a worker. Done when a node's brief in a fixture run carries the run goal and the node's plan line, and a test pins it.
