# WP-186: The Today page: what was worked on, day by day

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | L | 70, 78, 157 | yes |

From PLAN.md, "Ideas from kitze's factory teaser", item 7. Ideas only, nothing credited.

## Goal

A Today page shows what was worked on today, or on any other day the person picks: the work grouped by status (or by
project, or by agent), how long agents worked with an hourly bar, messages sent and received, to-dos agents finished
against those still waiting for review (accepted, sent back), decisions made by the app against those the person
made, and chats that were active against those that finished.

## What Hivra has

- The work log (WP-157, `src-tauri/src/work_log.rs`): one line per finished task, decision, correction or note;
  `work_log_read(project, day, from, to)` reads a day or a range. `src/features/workLog/model/morningLines.ts` already
  turns a day into lines.
- The activity log (WP-78, `src-tauri/src/activity.rs`): `list(ListQuery)` by project, agent, kind and cursor; no date
  range yet.
- Tasks (WP-70): statuses and the `task_activity` table (who moved what, when). Delegations carry the accept or send
  back (`delegations.rs`, WP-40's `gateVerdict`).
- Decisions (`src-tauri/src/decisions.rs`): `answered_by` and `answered_at`; an answer by the asking chat itself
  (`chat:<id>`) is the app's or an agent's, a person's answer is not.
- Turn timing: `src-tauri/src/harness_runs.rs` knows when each chat was in a turn, but only in memory for the running
  app. Nothing durable records turn spans.
- The old Today screen was retired in WP-06 because it showed chat state, not a day's work.

## What to build

1. **Durable turn spans.** A small table `turn_spans(session_id, started_at, ended_at, project)` written where
   `harness_runs.rs` opens and closes a turn, pruned after 400 days. Time worked for an hour is the union of spans in
   that hour, so two agents working at once count once for "time agents were working" and twice for "agent time";
   the page says which one it shows.
2. **One day query** `today_read(day, project?)` (new `src-tauri/src/today.rs`) that returns, for the local day: the
   work log lines; tasks that changed status that day (from `task_activity`); delegations accepted and sent back;
   decisions answered, split by person or app; messages sent by the person and replies received (from session
   blocks' timestamps); chats active that day and chats that finished; the hourly spans. All counting is in this
   query or one pure TypeScript function, never in the view.
3. **The page** (`src/features/today/`, new) in the rail under Home: a date control (today by default, arrows for
   the day before and after, a calendar to jump), a group-by control (status, project, agent), the hourly bar (24 thin
   bars, plain SVG), and short sections with their numbers: Work, Reviews (accepted, sent back, waiting), Decisions
   (by you, by the app), Messages (sent, received), Chats (active, done). Each line links to its task, chat or
   decision.
4. A first mate can read the same day through an `app today.read` action, so "what did we do on Tuesday?" is answered
   from the query, not from memory.

## Rules

- Counts and the chart live on this page, never on Home (WP-73 rule 6).
- Read-only, no model call, no new outward network call.
- Never weakens existing approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it
  exists).
- Days follow the person's local time zone; a day with no records says "Nothing was recorded on this day."
- The new table holds ids and times only, never message text; it goes into exports with the other history.
- Upstream rules from PLAN.md: new modules; `lib.rs` and `App.tsx` get one-line hooks naming WP-186.

## Done when

- [ ] Red first: a Rust test seeds a day (two overlapping turns, a task moved to Done, one delegation accepted, one
      sent back, one decision by the person and one by a chat) and expects exact numbers from `today_read`.
- [ ] Tests: overlapping spans are not double counted for working time; a turn across midnight splits between days;
      a different time zone moves a span to the right day; spans are pruned at 400 days.
- [ ] Browser spec `tests/browser/today-page.spec.ts` with seeded data: today's sections, moving to yesterday, each
      group-by, a link opening a chat, and the empty-day sentence. Screenshots in the PR.
- [ ] `npm run check` passes.

## Not in this package

The weekly retro (WP-157 has it). Billing or token cost (WP-127, WP-176). Anything on Home.
