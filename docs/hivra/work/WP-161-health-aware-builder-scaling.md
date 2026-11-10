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
2. Settings on the project Workers / Crew Defaults area: **Max builders** (default keeps today's 6, person can raise), **Pause new builders when** load average (1-min) exceeds N (default ~1.6 x cores), free memory below M GB, free disk below D GB. All off-able. Tests for sanitize and "running never killed".
3. A pure function `builderLaunchAllowed(health, limits) -> { ok, reason }` used by WP-160's tick and by `delegate_task` queue start. Tests with fixture health samples.
4. Read health through existing Tauri/OS helpers if present; otherwise a small Rust command (`uptime`, memory, `df`) with timeouts. Never shell user input. Cache readings for a few seconds.
5. Out of scope: killing processes, changing CI runners, paid cloud builders, reading `~/.claude`.

## Done when

- [ ] With thresholds crossed, new launches refuse with a plain reason; running work continues.
- [ ] Raising Max builders alone does not ignore health.
- [ ] Tests cover ok / load / memory / disk cases.

## Licence

Product behaviour. OpenMausBot sleep rule already credited for a related idea; no new copy.
