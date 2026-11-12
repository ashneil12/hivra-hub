# WP-250: First mates pick up tasks by rule, and tasks can be made on a schedule

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| P | M | 70, 180a | yes |

## Goal

A first mate can say which tasks it takes: a project, a set of statuses and a set of labels. A task that matches wakes
that first mate by itself, once, without Ash assigning it. An automation can create a task on a schedule, so recurring
work lands on the board and the matching first mate picks it up.

## Why

Up.computer (github.com/krl-gr/upcomputer, MIT) lets saved task agents start on any task whose project matches, whose
status is in `startStatuses` (empty means any) and that carries every `startTags` label (empty means none required),
once `notBefore` has passed. Today a Hivra task wakes only the first mate it is assigned to
(`src-tauri/src/tasks/store.rs` `wake`).

## Read first

- Up.computer `packages/tasks-server/src/agents/TaskAgentService.ts` (`startsForTask`, around line 146),
  `TaskTriggerSemantics.test.ts`, and `TaskRepositoryLive.ts` `triggerFieldsChanged` (which writes re-arm a trigger).
  Port the rule and its tests with credit.
- Hivra: `src-tauri/src/tasks/store.rs` (`wake`, `firstmate_wakes`, `pickup_text`), `src-tauri/src/watcher/queue.rs`,
  `src/features/automations/model/automationTemplates.ts`, `src-tauri/src/automations.rs`.

## Build

1. **Pickup rule** per first mate, kept in the app database: `project` (optional), `statuses` (list), `labels` (list),
   `enabled`. A rule with no statuses and no labels is refused in the UI ("this would take every task").
2. **Match** on create and on a write that changes title, description, status, labels, due date or trash (Up.computer's
   trigger fields). A matched task with no assignee is assigned to that first mate and wakes it through the existing
   `wake` (one wake per owner and key, so a re-save never wakes twice). A task the person owns (`assignee = person`)
   or a trashed task never matches. Two rules matching the same task: the earliest rule wins, stated in a test.
3. **Scheduled tasks**: an automation action "Create a task" (project, title, description, labels, status). It writes
   through `tasks.create` with `source = agent` and the automation's name in the description footer.
4. **UI**: the first mate's settings show "Picks up tasks" with the three pickers; the task shows "Picked up by rule".

## Done when

- [ ] Rule tests ported from `TaskTriggerSemantics.test.ts` (credit in the file header), plus: no double wake, person
      tasks never match, trashed tasks never match, earliest rule wins.
- [ ] The automation action creates a task that a matching rule picks up (integration test).
- [ ] Browser spec for the settings row; before/after screenshots.
