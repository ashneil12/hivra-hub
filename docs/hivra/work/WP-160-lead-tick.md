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

- [ ] With Lead tick off, nothing runs.
- [ ] With it on and Ship on green off, the tick launches and checks but never merges.
- [ ] Security-park rows are never merged.
- [ ] Tests cover the five steps with fakes; browser spec for the two settings.

## Licence

Product behaviour. Reuses Hivra delivery and habits. Ideas only from firstmate's timed wakes (MIT), already in the tree.
