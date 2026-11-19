# WP-147: Firstmate watcher stays armed after a successor dies

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Upgrade (source watch 9 Nov) | S | none (first mate / zero-token watcher already in tree) | yes |

## Goal

If Hivra's port of firstmate's zero-token watcher drops when a successor or child arm dies, adopt the upstream fix so the watcher stays armed. Note only (do not build) their opt-in adaptive lane budget from host vitals (`14d06b0`) for a later capacity package.

## Why

Digest 2026-11-09: firstmate `74ba960` keep the Pi watcher armed after a successor or arm child dies. We copied that watcher. Related: `578fa75` (quiet captain-hold reminders / backoff), `bf421ee` (export active home to workers) — take only what maps cleanly.

## Read first

- firstmate MIT: `74ba960` and the watcher module it touches.
- Hivra first-mate / watcher / wake-queue paths on `origin/main`.

## Build

1. Docs copy to `docs/hivra/work/WP-147-firstmate-watcher-arm.md`; note the fix on the existing firstmate credit.
2. Reproduce or unit-test the "successor/child dies → watcher disarmed" failure if present; fix to stay armed. If Hivra's code already cannot hit the bug, document with code cites and stop without fake refactors.
3. Out of scope: adaptive lane budget implementation, Pi-specific binaries, new network listeners.

## Done when

- [x] Watcher remains armed across successor/child death, or a written proof it cannot hit the bug.
- [x] Credits/SOURCES only as needed.

## Result

The bug class cannot happen here. No watcher code was changed.

`74ba960` is not in the firstmate tree this repo was studied against (`c6b6232`, `docs/hivra` source watch). The subject is the Pi extension, which arms a shell child and must stay armed when that child or a successor dies. At `c6b6232` that supervisor is `.pi/extensions/fm-primary-pi-watch.ts`: `startArm` spawns `bin/fm-watch-arm.sh` (`spawn("bash", … exec "$FM_WATCH_ARM_SCRIPT" --restart)`, line 1112), and the child's `close` handler (line 1164) either schedules another arm (line 1191) or, while a successor is still being restored, keeps a deferred close (lines 1181–1188). Hivra has neither file, nor any spawn of `fm-watch-arm.sh`.

Hivra's watcher is two looks inside the main window, plus a database queue:

- `useFirstMateWakes` (`src/features/firstmate/hooks/useFirstMateWakes.ts`) runs only when `getCurrentWindow().label === "main"`. It calls `look()` once, then `setInterval(look, WAKE_LOOK_MS)`. The interval is cleared only when that hook unmounts. A failed `deliver()` is logged; it does not clear the interval.
- The hook is called once from `App` (`src/app/App.tsx`, `useFirstMateWakes({…})`), not from a session. Replacing a first mate, or a worker exiting, does not unmount it.
- `useStallWatch` (`src/features/monos/hooks/useStallWatch.ts`) is the other look, reached from `useDelegationTree`, which `App` also calls once. Its interval effect has empty deps. A throw from a folder read is caught so "one bad read must never stop the loop". `silent()` settles and stops that one worker; the interval keeps going.
- Wakes live in `firstmate_wakes` (`src-tauri/src/watcher/queue.rs`). `drain` disposes a stall or blocked notice whose worker settled, stopped, or was retried under a new `delegations.generation`. That drops a stale notice. It does not stop the look. A new process sees the same rows (`queue.rs` `ensure_tables` / the restart note in `src/features/firstmate/watcher/README.md`).

`docs/hivra/firstmate-parity.md` already marks the shell arm as not applicable: "Arm, checkpoint, triage, wedge cap" drive a shell watcher in a pane. There is one poller in this process, not a watcher lock per home.

Not taken, because they do not map:

- `578fa75` quiet captain-hold reminders. Captain hold is already not applicable (`fm-captain-hold.sh`); Hivra's hold is `decisions.rs`.
- `bf421ee` export the active home to workers. Hivra has no firstmate home to export.
- `14d06b0` opt-in adaptive lane budget from host vitals. Not built. Capacity stays out of this package.
