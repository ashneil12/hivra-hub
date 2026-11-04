# WP-71: Boards: kanban, list and timeline

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | L | 70 | yes |

## Goal

Each project has a Tasks view with three layouts (Board, List, Timeline) and saved views, and the person can watch
their agents' cards move live as the work happens.

## Why

Ash, 4 Nov, after looking at Orbit: "a kanban board, and the other board types". Orbit's views are well tested and
Apache-2.0, so we copy their logic and restyle it, sleeker and simpler.

## Read first

- Orbit `apps/web/src/features/views/` (`viewState.ts`, `grouping.ts`, `filterTree.ts`, `filterFields.ts`,
  `layoutGroups.ts`, `taskTree.ts`, `nestDrop.ts`, `useCollapsedGroups.ts`, `autosave.ts`, `viewActions.ts`, and their
  tests), `features/tasks/components/` (`TaskBoard.tsx`, `TaskList.tsx`, `TaskRow.tsx`, `TaskDetail.tsx`,
  pickers, `BulkBar`), `features/tasks/timeline/`, `apps/server/src/repositories/views.rs`, `.ai/UI_CONVENTIONS.md`.
- WP-70, WP-15's Crew tab (where a worker's chat opens), CLAUDE.md "dev loop".

## Build

1. **Where it lives.** "Tasks" in each project's rail, next to the coding team, and one "All tasks" view across
   projects. Small hook in the rail, new module under `src/features/tasks/`.
2. **Board.** Columns are the project's statuses. Drag across columns changes status; drag within a column orders
   (placeholder while dragging). Inline status and priority without opening the task. A card shows title, assignee
   (person, first mate or Mono, with its avatar), labels and sub-task progress. An agent card also shows its CLI and
   how long it has been working, and opening it offers the worker's chat. Cards move by themselves on
   `tasks://changed`.
3. **List.** Rows grouped by status (or any field), nested sub-tasks, multi-select with a bulk bar (status,
   priority, assignee, labels).
4. **Timeline.** Bars from start to due date, or for agent work from start to finish, by project or assignee.
5. **Views.** Filters, grouping, sorting and display options, saved per project and in "All tasks"; one default view
   that can't be broken.
6. **Task detail.** A side panel: title, description (Markdown now; WP-72's editor when it lands), status, priority,
   assignee, labels, parent and sub-tasks, due date, activity and comments.
7. **New task.** One keystroke creates an empty task and opens its title (Orbit's flow, no modal).

Vendor the pure logic files and their tests from Orbit with credit. Orbit's components use Tailwind and shadcn; Hivra
doesn't, so rebuild them in Hivra's CSS and theme tokens, keeping Orbit's behaviour (and saying so in the PR).
Don't add Tailwind. Keep it minimal: no counters, no status chips beyond what a card needs.

## Done when

- [ ] Browser specs: drag a card across columns changes its status; a fake delegation moving through its states moves
      its card live; list grouping and bulk edit; timeline renders agent work; a saved view survives reload.
      Screenshots of all three layouts in the PR.
- [ ] Ported Orbit tests pass.
- [ ] `npm run check` passes; a dev-copy check by Ash: watch a real brief move across the board.
