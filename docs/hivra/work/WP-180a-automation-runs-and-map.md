# WP-180a: Automation runs in plain words, and a map of what feeds what

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 78 | yes |

From PLAN.md, "Ideas from kitze's factory teaser", item 1 (the run feed and the canvas). The webhook trigger is
[WP-180b](WP-180b-automation-webhook-trigger.md). kitze's teaser is a product tour: ideas only, nothing credited.

## Goal

The person can see, in one place, every automation run as it happens ("Started by the 9:00 schedule", "Finished",
"Failed: the Claude login has expired") and a read-only map of what feeds what: which trigger starts which
automation, and where its work lands (a chat, a worktree, a project).

## What Hivra has

- `src-tauri/src/automations.rs`: automations with several triggers each (`AutomationTrigger`, kinds `time`,
  `github`, `linear`, `jira`, `gitlab`, `azuredevops`), and a run list per automation (`AutomationRun`, `status`,
  `error`, `trigger`, `event_kind`, `session_id`), written through `automations_claim_due`, `automations_claim_event`
  and `automation_run_update`. Runs are capped at `MAX_RUNS_PER_AUTOMATION` (100).
- `src/features/automations/ui/AutomationsView.tsx` shows one automation's runs. There is no list across all of them.
- WP-78's activity log (`src-tauri/src/activity.rs`, `record`, `Actor::app()`; `src/features/activity/ui/ActivityPage.tsx`).
  Automation runs do not write to it today.
- No graph library is in `package.json`. `src/features/orchestration/ui/GoalGraph.tsx` draws its graph by hand.

## What to build

1. **Runs reach the activity log.** `automation_run_update` writes one activity line when a run starts, finishes or
   fails: `automation.started`, `automation.completed`, `automation.failed`. The line names the automation and what
   started it ("the 9:00 schedule", "a new issue in owner/repo"). A failed run carries its reason in plain words, from
   one pure function `failureLine(error, errorClass)` that maps the classes `crew/failure.rs` already knows (auth,
   usage, billing, missing CLI) to a sentence, and falls back to the first line of the error with secrets scrubbed
   (`portable::scrubber`).
2. **A Runs tab on the Automations screen**: every run across automations, newest first, live from the activity
   event the log already emits. Filter by automation and by result. A line opens the run's chat.
3. **A Map tab**: a left-to-right drawing in plain SVG. Column one is triggers, column two automations, column
   three where the work goes (project folder, worktree mode, reused chat). Edges come from `automations_list` only.
   A disabled automation is drawn faded. A node opens the automation's editor. No dragging, no editing on the map.
4. One pure layout function (`mapLayout(automations)`) returns nodes and edges with positions, so the layout is
   tested without a browser.

## Rules

- Read-only map. Nothing here starts, edits or deletes an automation.
- No new outward network call. No new trigger kind (webhooks are WP-180b).
- Never weakens existing approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it
  exists).
- The activity line holds names and reasons, never the automation's prompt text and never a secret.
- New code in `src/features/automations/` (new files) and a small hook in `automations.rs`; `App.tsx`, `lib.rs` and
  `SettingsView.tsx` stay hook-only, each hook with a comment naming WP-180a.
- Follows the upstream rules in PLAN.md: upstream's Automations view gets tabs through the smallest hook, and its code
  is not reordered.

## Done when

- [ ] Red first: a Rust test shows a finished and a failed run write no activity line today; then it passes with one
      line each, and a retried `automation_run_update` writes no second line.
- [ ] `failureLine` tests: each known class gives its sentence; an unknown error gives its first line; a key in the
      error is scrubbed.
- [ ] `mapLayout` tests: two triggers on one automation, one trigger on two automations, a disabled automation, no
      automations (an empty map says "No automations yet").
- [ ] Browser spec `tests/browser/automation-runs-map.spec.ts`: seeded runs show in Runs with the right words, a new
      run appears live, a filter narrows the list, the Map draws the seeded edges and a node opens the editor.
      Screenshots in the PR.
- [ ] `npm run check` passes.

## Not in this package

The webhook trigger (WP-180b). Editing automations on the map. Charts or counts of runs. Running automations from the
host while the laptop is closed (WP-196a).
