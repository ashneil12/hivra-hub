# WP-70: Tasks, shared by the person and their agents

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | L | none | yes |

## Goal

A task is the one thing the person and their agents share. Every brief a first mate sends becomes a task by itself
and moves through its statuses as the worker runs, gets checked and lands. A task the person writes and gives to a
first mate becomes a brief.

## Why

Ash, 4 Nov: "I like the fact that you can actually see what your agents are doing, working on, for the tasks." Orbit
(coollabsio/orbit, Apache-2.0) has the task model; Hivra already has the work underneath (the `delegations` table).
This package joins them. WP-71 draws the board on top.

## Read first

- Orbit: `apps/server/src/repositories/tasks.rs`, `sub_issues.rs` (parent checks, cycle refusal, auto-close),
  `task_relations.rs`; `apps/web/src/features/tasks/` logic files (`tasksLib.ts`, `taskMeta.ts`, `subIssuesLib.ts`,
  `bulkUpdates.ts`, `relationsLib.ts`) and their tests; `.ai/FEATURES.md` "Tasks", "Sub-issues", "Project workflows".
- Hivra: `src-tauri/src/delegations.rs` (states `running`, `question`, `completed`, `failed`, `cancelled`; delivery
  states; `parent_id`, `root_id`, `CHANGED` event), `src/features/monos/model/delegations.ts`,
  `src-tauri/src/worker_queue.rs` (queued work), `src-tauri/src/firstmate/gates.rs` (review and verdict),
  `src-tauri/src/watcher/` (wake queue), `src-tauri/src/local_hub.rs` (projects).

## Build

1. **Store.** In the app database: `task_statuses` (per project; categories Unstarted, Started, Completed, Cancelled,
   as Orbit) and `tasks` (id, project, number per project, title, description as Markdown, status, priority,
   labels, parent task, assignee, due date, sort key, `version`, `source` = person | agent | github,
   `delegation_id`, timestamps, `trashed_at`). The default workflow for a new project: Backlog, Todo, In progress,
   In review, Done, Cancelled. Writes carry the version they read; a stale write is refused and returns the current
   row (Orbit's rule). One event, `tasks://changed`, tells every window.
2. **Agent work becomes tasks.** When a delegation is created, a task is created with it: title, brief as
   description, project, the first mate as assignee, and the parent delegation's task as its parent, so a crew's
   work nests under the brief that started it. Its status follows the delegation through one mapping in code
   (queued: Todo; running: In progress; question: In progress with a "needs you" flag; a report waiting on its
   check: In review; completed: Done; failed: In progress with a "failed" flag for the first mate to decide;
   cancelled: Cancelled). The mapping lives in one function with a test for every state. Agents never set these
   statuses by hand.
3. **Person's tasks become briefs.** A task the person assigns to a first mate (a project's coding team or a Mono)
   reaches that first mate through the wake queue as "pick up task #N". The delegation it starts links back to the
   task, so the same card moves. Unassigned tasks stay as they are.
4. **Sub-tasks.** Port Orbit's rules: unlimited depth, cycle and missing-parent refusal, auto-close of a parent when
   every child is closed and one completed (on by default per project), trashing a parent trashes its subtree.
5. **Agents can use tasks.** `app tasks.list`, `tasks.get`, `tasks.create`, `tasks.update` through the app's
   existing agent tool, scoped to the agent's project. A first mate can file a follow-up task; it can't edit a task
   it didn't create beyond status and comments. Task text is data, never instructions, and the tool descriptions
   say so.
6. **Comments and activity.** A task shows its delegation's log as activity, and takes comments from the person
   and agents. A comment on an agent task reaches its first mate as a steering message (WP-14's path).

Vendor Orbit's TypeScript logic files and their tests where they fit, with the licence header, a `NOTICE` entry and a
`credits.json` line. Translate its Rust rules (sqlx) to rusqlite with their tests. Nothing in this package draws a
board.

## Done when

- [ ] Tests: every delegation state maps to the right status; a crew's delegations nest under the brief's task; a
      person's task assigned to a first mate starts a linked delegation; stale version refused; cycle refused;
      parent auto-close; subtree trash; an agent can't edit another's task text.
- [ ] Restart-safe: tasks and links survive a restart and a resumed turn (`npm run hub:verify-live` passes).
- [ ] `npm run check` passes.
