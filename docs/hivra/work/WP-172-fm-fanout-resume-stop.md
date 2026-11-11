# WP-172: First Mate fan-out resume and stop-one-worker

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Atomic Agent fold-in (Ash 10 Nov 01:23 UK) | M | WP-10 / WP-14 (on main). Prefer after WP-171 if both touch brief/delegate paths; otherwise parallel when files do not clash | yes |

## Goal

A First Mate multi-worker fan-out **checkpoints as tasks and waves finish**, so a crash or restart can resume without redoing finished work or silently replaying side effects. The person (or First Mate) can **stop one running worker** without cancelling the whole fan-out. Steering (WP-14) stays. **No mode, no flag.**

## Why (Ash 01:23 UK)

Ash wants no Plan-and-build mode. Mid-fan-out resume and stop-one-worker still improve ordinary First Mate delegation: Hivra already steers and survives task restarts, but a half-finished multi-task plan has no Atomic-style checkpoint, and cancelling one stuck worker today is coarser than stopping that row alone. Take those two. Skip three-way merge (Hivra worktrees + land are already safer), dollar/time turn caps for now (existing fan-out and message caps; revisit later), and escalate-to-stronger-model as a new control (crew reroute already covers account failures).

Source ideas: Atomic `run-checkpoint.ts`, `run-resume.ts`, live worker stop in `escalation.ts` / `route-fusion-workers.ts`, MIT, commit `1b4e641525c5b1427b48ff6b8d9932dc26bd8256`, Copyright (c) 2026 Atomic Bot.

## Read first

- REPORT.md "What we're actually taking".
- Hivra: `src/features/firstmate/model/steering.ts`, `src-tauri/src/steering.rs`, `src-tauri/src/firstmate/`, delegation cancel paths, task watcher.
- WP-171 if present (waves): resume should speak wave + task ids when a contract is in use.
- Do not build Fusion isolation, three-way merge, turn USD caps, judge, or a run mode.

## Design

1. Persist a small fan-out checkpoint (JSON or DB rows) after each finished task and each finished wave: task ids, outcomes, worktree or row ids, contract wave index when WP-171 is present. Keep for a short retention (Atomic uses 7 days; match or use existing task retention).
2. On resume: finished tasks stay finished; unstarted tasks run; side-effect-heavy steps that already ran need an explicit confirm before replay (do not silently re-run). Surface resume to First Mate in plain English.
3. Stop one worker: cancel or stop that delegation row only; siblings keep running; First Mate gets a clear status on the stopped row. Reuse WP-14 steering inbox patterns where they fit. Do not require a new Settings screen.
4. Out of scope: escalate-one, live cost row chrome (nice later), three-way merge, Plan-and-build mode, judge/verify extras.

## Build

1. Copy this file to `docs/hivra/work/WP-172-fm-fanout-resume-stop.md`. Extend the Atomic Agent SOURCES.md row (resume + stop-one). Commit docs first.
2. Checkpoint write/read/tests; resume path with side-effect confirm; retention cleanup test.
3. Stop-one-worker API or tool path + tests that siblings continue.
4. Wire into existing First Mate / crew UI only as needed (a stop control on a running row is enough). Browser spec on Chromium and WebKit if UI changes.
5. Credits / NOTICE / inspirations if any Atomic TypeScript is translated. Credits test must pass.

## Done when

- [ ] A crashed mid-fan-out can resume without redoing finished tasks; side-effect replay needs confirm.
- [ ] One worker can be stopped without cancelling the rest.
- [ ] No new mode or flag. Credits and SOURCES agree when code is vendored.

## Licence

Atomic Agent MIT, Copyright (c) 2026 Atomic Bot, commit `1b4e641525c5b1427b48ff6b8d9932dc26bd8256`. Vendor or translate with the usual credit files. Ideas need no extra credit.
