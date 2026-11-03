# WP-09: Ship and autopilot on Windows and Linux

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| D | L | 02 | no |

## Goal

The parts of the Hub that only work on macOS today work on Windows and Linux too: installing a build with
rollback, keeping the machine awake during autopilot, relaunching after a crash, and storing secrets.

## Why

Ash wants Windows. These are the pieces that are macOS-only by design today (SPEC.md section 11).

## Read first

- `src-tauri/src/ship.rs`, `scripts/hub-ship.mjs`, `scripts/hub-ship-runner.mjs` (LaunchAgent, `ditto`,
  `~/Applications`).
- `src-tauri/src/autopilot.rs` (IOPMAssertion keep-awake, crash relaunch LaunchAgent).
- `src-tauri/src/hub_keychain.rs` (Keychain names).
- Upstream's remote host service install (`docs/remote-access.md`: systemd user service, Windows Task Scheduler):
  reuse its approach rather than inventing one.

## Build

1. A platform seam for each of: install location, staged swap with rollback, one-shot runner after quit,
   keep-awake, crash relaunch, secret storage. macOS keeps its current code behind the seam unchanged.
2. Windows: Task Scheduler for the runner and relaunch, `SetThreadExecutionState` for keep-awake, Credential Manager
   for secrets, `%LOCALAPPDATA%\Programs` for the install. Linux: systemd user units, `systemd-inhibit`, Secret
   Service, `~/.local/share`.
3. The ship tests run on all three platforms in CI under a temporary HOME.

## Done when

- [ ] `hub:ship -- --drill-rollback` passes in CI on Windows and Linux under a temporary HOME.
- [ ] Autopilot's keep-awake and relaunch have tests per platform.
- [ ] macOS behaviour is unchanged (existing tests pass untouched).
