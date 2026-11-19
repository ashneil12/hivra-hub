# WP-185b: To-dos and a scratchpad on Home

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | S | 73, 70, 185a | yes |

From PLAN.md, "Ideas from kitze's factory teaser", item 6 (to-dos with draft and ready, notes and a scratchpad).
Ideas only, nothing credited.

## Goal

The person can keep their own to-dos and a quick scratchpad on Home. To-dos are split into Draft (still being shaped)
and Ready (can be picked up). The scratchpad is one note that saves as they type. Both are sections they can turn on,
move or hide.

## What Hivra has

- Tasks (WP-70, `src-tauri/src/tasks/store.rs`): each project's workflow is seeded by `ensure_workflow` with Backlog
  and Todo (category `unstarted`), In progress, In review, Done, Cancelled. Agents may not set a status that "follows
  the work" (`tasks/store.rs`, the actor check).
- Notes (`src-tauri/src/notes.rs`, `src/features/notes/notes.ts`): titled notes with tags, versions and images.
- Home's arrangement (`src/features/home/model/arrangement.ts`): built-in sections and pinned panels, kept in the
  app's store and in exports.

## What to build

1. **A `todos` section.** Tasks the person created or that are assigned to them, across projects, in two groups:
   **Draft** (status category `unstarted` and name Backlog, or a project's first unstarted status) and **Ready** (the
   next unstarted status, Todo by default). One line each with its project; a tap opens the task. A small "Add" field
   creates a Draft task in the project the person picks (remembered). Moving a task from Draft to Ready is one tap and
   uses the existing `tasks_update`.
2. **A `scratchpad` section.** One note, made on first use with the title "Scratchpad" and the tag `scratchpad`,
   edited in place with a plain text box; saved after a short pause through the notes commands, so it keeps
   versions and shows in Notes and the finder. A note only, never sent to an agent unless the person shares it.
3. Both are new `BUILTINS`, **hidden by default**, including in an existing saved arrangement; "Arrange Home" lists
   them so the person can turn them on.
4. Neither section shows a number (WP-73 rule 6).

## Rules

- Off by default (hidden sections). No change to Home for someone who never turns them on.
- Only the person's own to-dos; agent tasks stay in Moving now and Tasks.
- No model call, no new outward network call.
- Never weakens existing approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it
  exists).
- Upstream rules from PLAN.md: new files in `src/features/home/`; `HomeView.tsx` gets small hooks.

## Done when

- [ ] Red first: an arrangement test expects `todos` and `scratchpad` hidden in a fresh and an old arrangement.
- [ ] Tests: grouping by status category for the default and a renamed workflow; adding creates a Draft task;
      "Ready" moves it; the scratchpad note is made once, not twice from two windows (the store's revision check).
- [ ] Browser spec `tests/browser/home-todos-scratchpad.spec.ts`: turn both on, add a to-do, move it to Ready, type
      in the scratchpad, reload and see it kept, find it in Notes. Screenshots in the PR.
- [ ] `npm run check` passes.

## Not in this package

The paragraph and workspace cards (WP-185a). Reminders on to-dos. Sharing the scratchpad with an agent.
