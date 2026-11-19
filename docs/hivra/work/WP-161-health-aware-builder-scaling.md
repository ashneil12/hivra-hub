# WP-161: Health-aware builder scaling

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| First Mate smoothness (Ash 10 Nov 00:14 UK) | S | WP-13 crew / worker_limits (on main), WP-159 helpful but not required | yes |

## Goal

The number of builders the First Mate starts at once follows a **ceiling the person set** and a **live health floor**: when load, free memory or free disk cross thresholds, new launches pause (running builders are never killed). Quota / account limits already pause via WP-13 reroute; this package adds machine health beside that.

## Why

Ash (9 Nov): run above 12 when the Mac can take it, up to 20, and when he plugged in he said use as much juice as possible. Tonight's launcher held below the ceiling when load spiked. Hivra's `worker_limits` are fixed counts; they do not read load, memory or disk.

## Read first

- `src/features/monos/model/workerPool.ts`, `src-tauri/src/worker_queue.rs`, `src-tauri/src/crew/reroute.rs`.
- OpenMausBot's watchdog sleep rule (already credited: sleep is not silence). Ideas only for "do not thrash when the machine is hot".

## Build

1. Docs to `docs/hivra/work/WP-161-health-aware-builder-scaling.md`.
2. Settings on the project Workers / Crew Defaults area: **Max builders** (default keeps today's 6, person can raise), **Pause new builders when** load average (1-min) exceeds N (default ~1.6 x cores), free memory below M GB, free disk below D GB. All off-able. Load and free disk are on by default (load at 1.6 x cores, disk at 30 GB); free memory is off until a person turns it on. Tests for sanitize and "running never killed".
3. A pure function `builderLaunchAllowed(health, limits) -> { ok, reason }` used by WP-160's tick and by `delegate_task` queue start. Tests with fixture health samples.
4. Read health through existing Tauri/OS helpers if present; otherwise a small Rust command (`uptime`, memory, `df`) with timeouts. Never shell user input. Cache readings for a few seconds.
5. Out of scope: killing processes, changing CI runners, paid cloud builders, reading `~/.claude`.

6. The free disk pause is **on by default at 30 GB**, and a builder it holds shows in Needs you (below).

## The free disk pause (default on, 30 GB)

- **Default.** `DEFAULT_FREE_DISK_GB = 30` in `builderScale.ts` (and the same number in `worker_queue.rs`). A fresh install, or a store with no saved scale, pauses new builders when the root disk has under 30 GB free. 29 GB pauses, 30 GB and 31 GB do not. The person can turn it off or change the floor in Crew defaults or the project Workers dialog; turning it back on brings 30 back.
- **Off is a choice, so it is stored as one.** A saved scale now carries `version: 2`. From version 2 on, a null disk pause means "turned off" and stays off. A scale saved before this change has no `version`, and its null disk pause only ever meant "never set" (the pause was off until a person turned it on), so it reads as the new default (30 GB). A number a person had chosen in an old row (say 5) is kept. `builderScaleFromStored` (web) and `clean_builder_scale` (Rust) do this, so it happens the same way whether the row is read by the app or cleaned on its way in. A row cannot tell an old "deliberately off" from "never set", because the old build wrote the same null for both; reading it as the default is the safe way round.
- **Not stored when it is the default.** A scale equal to the defaults (6, load default, memory off, disk 30) still clears the stored row.
- **A bad value is not an off.** A disk value that is missing, unreadable, negative or absurd falls back to 30. Only null, a blank, `false` or 0 turn it off.

## Needs you: new builders are waiting on disk

When at least one builder is waiting and a current reading is under the disk floor, Home's Needs you section leads with one line that names the free space: "New builders are waiting: 24 GB free, under the 30 GB floor". The free space is rounded down to one decimal, so a reading just under the floor never reads as the floor. The line has one action, **Free up space**, which opens Settings > Worktrees > Clean up through the same call the app's other Settings links use (`openSettings("worktrees", "worktree-cleanup")`, the card's `data-setting-id`). The line clears by itself when the disk is back over the floor, when nothing waits, or when the person turns the pause off. It names the disk even when the load pause is crossed too, because only the disk needs the person.

Two things make that line true in the running app, not only in tests:

- **The first launch meets the pause.** The launch gate only had a health reading once something was already waiting (the pump reads it, and the pump skips an empty queue), so the first `delegate_task` on a full disk would have started. `delegate` now reads the machine first (`refreshHealth` on the pool host, cached 4 seconds, 3 second timeout, never throws), then decides. A failed or slow read leaves the launch allowed, as before.
- **Waiting builders look again soon.** While any builder waits, the app looks at the machine every 10 seconds (it was up to 60), and a builder joining the queue resets that timer. The reading is good for 15 seconds, so the line does not go stale between looks, and a builder starts within about 10 seconds of space being freed.

## Done when

- [x] With thresholds crossed, new launches refuse with a plain reason; running work continues.
- [x] Raising Max builders alone does not ignore health.
- [x] Tests cover ok / load / memory / disk cases.
- [x] The disk pause is on by default at 30 GB: pauses at 29 GB free, not at 31 GB.
- [x] A builder held by the disk pause shows in Needs you with the free space and a Free up space action that opens Settings > Worktrees > Clean up.
- [x] A scale saved before this change adopts the new default; a deliberate off stays off.

## Licence

Product behaviour. OpenMausBot sleep rule already credited for a related idea; no new copy.
