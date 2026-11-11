# WP-196b: One set of limits for every run nobody is watching

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | none (176 for a spend line, when merged) | no |

From PLAN.md, "From Aether", item 4 ("the caps cover routines, not every unattended run"). Ideas only, nothing
credited. The rules themselves are WP-61's, from OpenBot (MIT, already credited there).

## Goal

Every run that starts without the person in front of it (an automation, a habit, a lead tick, a webhook, a scheduled
run on a host) passes one set of limits in code: not more often than every 15 minutes per schedule, paused after
repeated failures, missed windows skipped, and a daily ceiling per project. A run that is held says why in one line.

## What Hivra has

- Limits in several places, each different: automations' `missed_run_grace_minutes`
  (`crates/monocode-core/src/automations.rs`); habits' `GRACE_MS`, `TIMEOUT_MS` and `APPROVAL_WAIT_MS`
  (`mono/habits.rs`); the lead tick's minimum of 5 minutes and its backoff (`src/features/leadTick/model/schedule.ts`);
  auto-resume's 3 tries (`MAX_AUTO_RESUMES`, `inFlight.ts`); the crew failure budget (`crew/budget.rs`).
- WP-61's routine rules (OpenBot): a 15-minute floor, stop after repeated failures, skip missed windows.
- WP-176 (open as a PR) adds spend limits on measured cost.

## What to build

1. **One pure gate** (`crates/monocode-core/src/unattended.rs`, with a TypeScript twin for the webview and the host,
   kept in step by one shared JSON table of cases): `allow(start, history, limits, now)` returns `run` or `hold` with a
   reason. Limits:
   - **Floor:** a schedule may not start again within 15 minutes of its last start.
   - **Failures:** after 3 failed runs in a row a schedule is paused; the person resumes it.
   - **Missed windows:** a start later than its grace is skipped, not made up.
   - **Daily ceiling:** at most 50 unattended starts per project per day (a setting).
   - **Spend:** when WP-176 has landed, a run is held when its project is over its limit.
2. **Every unattended start calls it:** automations (`automations_claim_due` and `automations_claim_event`), habits'
   claim, the lead tick, and WP-180b webhooks and WP-196a host runs (a caller that has not landed yet adds its call
   in its own package). A person's "Run now" is not unattended and is not held.
3. **What the person sees:** a held run writes one activity line ("Held: Nightly triage ran 3 times without success, so
   it is paused") and, for a pause, one Needs-you line with Resume. The automation editor shows the limits in force.
4. **Settings > Automations > "Limits for runs nobody is watching"**: the floor (15 to 240 minutes), failures (1 to 10),
   daily ceiling (1 to 500). Runs on a host or cloud machine always use them. Runs on this Mac use them only when
   "Apply on this Mac too" is on, which is off by default, so nothing that runs today changes until the person turns
   it on.

## Rules

- Off by default on this Mac (see step 4); always on for host and cloud runs, which are new.
- The gate never starts anything; it only says run or hold. No model call, no network call.
- Limits only tighten. Nothing here loosens an approval, a budget or the protected-path list
  (`src/shared/security/agentConfigPaths.json`, when it exists).
- Upstream rules from PLAN.md: a new core module; each caller gets a one-line call with a comment naming WP-196b.

## Done when

- [ ] Red first: the shared case table (floor, failures, missed window, ceiling, a person's Run now) runs in Rust and
      TypeScript and fails before the gate exists.
- [ ] Tests: each caller passes through the gate (one test per caller with a fake history); a held run starts nothing
      and writes one line; Resume clears a pause; "Apply on this Mac too" off leaves desktop runs exactly as today.
- [ ] Test: with WP-176 present, a project over its limit holds; without it, the spend check is skipped and says so.
- [ ] Browser spec `tests/browser/unattended-limits.spec.ts`: the settings, a seeded held line, and Resume.
      Screenshot in the PR.
- [ ] `npm run check` passes.

## Not in this package

Spend measurement (WP-176). Moving schedules to a host (WP-196a). Limits on runs the person starts.
