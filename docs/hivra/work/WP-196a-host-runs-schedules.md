# WP-196a: The host keeps schedules running while the laptop is closed

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | L | 60, 61, 196b | no |

From PLAN.md, "From Aether", item 4 (automations and routines still fire from the desktop). Limits for every
unattended run are [WP-196b](WP-196b-limits-for-unattended-runs.md). Ideas only, nothing credited.

## Goal

An automation or a Mono habit whose project lives on an added host can be handed to that host, so it fires on time
with the laptop shut. The desktop then shows what ran while it was away. Exactly one side fires each schedule.

## What Hivra has

- Automations fire from the desktop: `automations_claim_due` and `automations_claim_event` in
  `src-tauri/src/automations.rs`, with the schedule rules in `crates/monocode-core/src/automations.rs`
  (`next_run_at`, `missed_run_grace_minutes`). Mono habits: `crates/monocode-core/src/mono/habits.rs` (`Schedule`,
  `GRACE_MS`, `TIMEOUT_MS`, `APPROVAL_WAIT_MS`). The lead tick (WP-160) runs only while the app is open and says so.
- The host (WP-60) runs first mate records, leases and launch keys (`host/firstmate/`), and settles a brief with the
  desktop away; it has no scheduler.
- WP-61 plans "routines on the machine" with safety rules and an away feed; it provisions nothing.
- Dev copies turn automations and habits off.

## What to build

1. **Hand a schedule to a host.** An automation or habit whose folder is on an added host gets "Run on build-box,
   even when this Mac is off". Turning it on sends the automation (name, prompt, triggers of kind `time` only, model,
   folder, permission mode) to the host with a new method `schedules.adopt`, and marks it `owner: host:<id>` on the
   desktop. Turning it off (`schedules.release`) gives it back. GitHub and other event triggers stay on the desktop in
   this package.
2. **One owner, in code.** The desktop's `automations_claim_due` skips an automation owned by a host. The host claims a
   due run under a lease keyed by automation and slot time (the WP-60 launch key), so a desktop that still believes it
   owns the schedule after a lost release cannot start the same run.
3. **A scheduler on the host** (`host/schedules/`, new): the same next-run rules as the core, ported to TypeScript with
   the core's tests as fixtures (one shared JSON table of schedule cases both sides run, so they cannot drift). It
   wakes once a minute, claims due runs, and starts them through the host's provider path as a first mate brief would.
   Missed windows past the grace are skipped, never made up.
4. **What ran while away.** Each host run is stamped with what started it (`schedule:<automation>`). On reconnect the
   desktop reads them through the WP-60 catch-up (`firstmate.catchUp`) and shows them once in the automation's Runs
   (WP-180a) and the activity log, with "ran on build-box".
5. The automation editor shows where it runs and when the host last answered.

## Rules

- Off by default per automation. Nothing moves to a host without the person's choice.
- No paid infrastructure and no new service: the host is one the person added. A Hivra Cloud machine uses the same
  path once WP-61 exists.
- WP-196b's limits apply to every host run from the first release of this package.
- The host never runs an automation the desktop did not hand it, and never changes one; edits go through release,
  edit, adopt.
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists): a
  run that asks for approval waits, as it does on the desktop, up to `APPROVAL_WAIT_MS`.
- Upstream rules from PLAN.md: new host module; `automations.rs` gets one skip check.

## Done when

- [ ] Red first: the shared schedule-case table runs on the core and fails on the host before the port exists.
- [ ] Tests on the upstream test host: an adopted daily automation fires once at its time with the desktop
      disconnected; the desktop does not fire it; a lost release cannot cause a second run (lease test); a missed window
      is skipped; release gives the next run back to the desktop.
- [ ] Test: reconnecting shows each host run once, with its start stamp.
- [ ] Browser spec `tests/browser/automation-on-host.spec.ts`: the per-automation choice, the "runs on" line, and a
      seeded away run in Runs. Screenshot in the PR.
- [ ] `npm run check` passes. A dev-copy check with a real SSH host and the app quit for an hour stays open until done.

## Not in this package

Event triggers on the host (they need the host to read GitHub). The lead tick on the host. Limits (WP-196b).
