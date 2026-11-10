# WP-160: First Mate lead tick

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| First Mate smoothness (Ash 10 Nov 00:14 UK) | M | WP-159, WP-11 watcher (on main), WP-12 delivery (on main), WP-155 ship-on-green (queued) | yes |

## Goal

On a schedule the person sets (default every 15 minutes while the app is open), the project's First Mate runs one **lead tick**: read the programme queue, start the next free package if capacity allows, review open PRs' CI, and for non-park packages call the dry-run ship helper (WP-155) and only merge when the person has turned **Ship on green** on for that project. Quiet about routine progress; wake the person only for parked items or real blocks.

## Why

Tonight's CoS lead ticked every 15 minutes, merged what was safe, and left security work parked. Hivra has habits (WP-88 morning), a watcher, and delivery merge authority, but no First Mate pass that drives a multi-package programme the way that lead did.

## Read first

- WP-159 programme queue, Mono habits (`crates/monocode-core/src/mono/habits.rs`, `src/features/chief/model/habit.ts`).
- WP-11 watcher timers, WP-12 merge path, WP-155 `scripts/hivra-ship-green.mjs` (dry-run default).
- WP-10: the lead never edits the project itself; workers do the builds.

## Build

1. Docs first to `docs/hivra/work/WP-160-lead-tick.md` + SOURCES note.
2. Project setting **Lead tick**: off by default; interval minutes (min 5, default 15); **Ship on green** off by default (merge apply stays off until the person turns it on). Tests for sanitize.
3. Tick steps, each tested with fakes: (a) load programme queue; (b) if a builder slot is free (WP-161 when present, else worker_limits), mark next `queued` package `building` and enqueue a normal `delegate_task` with that brief (do not shell out to external launchers); (c) for open PRs tied to programme rows, read CI via existing `pr_watch` / `gh` helpers; (d) if Ship on green is on, call WP-155 helper with `--apply` only for non-`security_park` rows that are green; else dry-run and log; (e) write a short tick line to the activity log / work log when WP-157 exists.
4. Habit or watcher timer fires the tick while the desktop is open. Honest copy if a closed app will miss ticks (same honesty as WP-128). No LaunchAgent in this package.
5. Out of scope: health scaling (WP-161), rebase/locks (WP-162), quiet hours (WP-164), overnight scout (WP-165).

## Done when

- [x] With Lead tick off, nothing runs.
- [x] With it on and Ship on green off, the tick launches and checks but never merges.
- [x] Security-park rows are never merged.
- [x] Tests cover the five steps with fakes; browser spec for the two settings.

## Licence

Product behaviour. Reuses Hivra delivery and habits. Ideas only from firstmate's timed wakes (MIT), already in the tree.

## As built

Code: `src/features/leadTick/` (model, hook, Crew tab card), mounted by one hook line in `src/app/App.tsx` and one
line in `src/features/crew/ui/CrewPanel.tsx`.

- **Settings** (`model/setting.ts`, `model/store.ts`). Per project folder, in the hub document `lead-tick` in the
  app's database: Lead tick off, every 15 minutes (5 to 240), Ship on green off. The same document keeps each
  project's last tick, its line, and what was already said once.
- **When it runs** (`model/schedule.ts`, `hooks/useLeadTick.ts`). The main window looks once a minute while the app
  is open. A project ticks when its Lead tick is on and its interval has passed. The tick runs through quiet hours
  (WP-164): quiet hours hold the pings, not the work. It does not run while the project's Lead chat is working,
  asking, holding queued messages, paused on a usage limit or stopped resuming (the WP-11 rule), or where the app's
  policy turns automations off (a dev copy). One tick per project at a time. A run that cannot be recorded backs off
  for five minutes. No LaunchAgent: the Crew card says the tick runs only while Hivra is open, and when no tick ran
  for more than two intervals it says for how long and that missed ticks are not made up.
- **One tick** (`model/tick.ts`, `model/ports.ts`), acting as the project's Lead (`teamLeadOf`):
  1. reads the programme as the first mate (`programme_list`);
  2. reads the PR watches (`pr_watch_list`) for the programme's `building` and `pr_open` rows by branch, in the row's
     own project only, and ignores a watch that ended before the row was claimed: an open pull request moves a row to
     `pr_open`, a merged one to `merged` with one work log outcome line. A `building` row with no pull request six
     hours after it was claimed is settled to `failed`, so its builder slot is free. A red CI is said in the line
     only, since the PR watch already sends the `ci-red` notice;
  3. for a green pull request (open, not a draft, checks passed, none pending, not conflicting): with Ship on green
     off it says once per head that it waits for the person; with it on it calls delivery's one merge path
     (`delivery_merge`) as the Lead, never as the person. That path reads the pull request again, refuses red,
     pending, draft and conflicting ones and open decisions, pins the head, and merges without asking only when the
     project's Merge without asking is on; otherwise it answers that the person's word is needed, and the tick says
     so once. Just before the merge the row is read again, so a park that landed during the read holds it. A
     `security_park` row, a parked row, or a pull request on the never-merge list (WP-92, WP-150, WP-158, or a
     security-park label or title) is never sent to it. The list lives in `model/neverMerge.json`, read by the tick
     and by `scripts/hivra-ship-green.mjs`, so there is one copy. The helper itself is not run: it only prints a
     command, and a tick does not shell out;
  4. starts at most one queued, non-parked package when a builder slot is free: the project's worker limit (open
     workers, waiting workers, and packages already building all count) and the builder health pause (WP-161). It
     claims the row (`building`), then asks the Lead's own `delegate_task` with the brief path, branch and a definition
     of done, so the fresh-eyes hold (WP-144) and the worker queue apply. A brief held for review counts as started.
     A failed start marks the row `failed`;
  5. writes one activity line (`lead.tick`) when it did something; a quiet tick writes none. What needs the person
     goes to the batched notable pings: as `lead-tick` (WP-164), or as a held notice inside quiet hours, which
     leaves when the window ends. Each said-once key is short (a long reason or row id becomes a hash) and the store
     keeps the newest 200 per project.
- **Not in this package:** health scaling beyond the WP-161 gate (WP-161), rebase and stale locks (WP-162), quiet-hours
  changes (WP-164), overnight scout (WP-165).
