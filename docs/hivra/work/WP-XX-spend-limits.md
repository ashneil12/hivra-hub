# WP-XX: Spend limits, with a warning and no new builders at the limit

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Unassigned (Ash to place; no wave chosen) | M | 13, 78, 161 | yes |

## Goal

The person can set a spend limit, in dollars, for one project or for the whole app, for a day or a calendar month. At the warning share the project's first mate hears once. At the limit, new builders are refused with a plain reason, through the same launch gate WP-161 uses for machine health. A builder that is already running is never stopped by this limit.

A second, narrower ceiling covers a run on a model its own provider bills per token: a spend ceiling per task and a daily ceiling for unattended runs, with a soft ask before a hard stop. It is the only thing here that may stop a run, and only that run.

## Why

Paperclip (MIT) describes budgets as tracking reported spend, alerting at thresholds and pausing work at configured limits. Hivra counts cost and never acts on it. The usage history adds up each turn's `costUsd` (`src/features/usage/model/history.ts`), and only the Claude Code and opencode adapters fill it (`src/integrations/harness/providers/claude/claude.ts`, `src/integrations/harness/providers/opencode/opencode.ts`). The limits Hivra does have are counts (Max builders in WP-161, worker limits in WP-13) and provider quota windows (WP-13 pauses on `resets_at`). No setting stops a project at a money figure, and API-key routes (`src-tauri/src/model_router.rs`) have no ceiling. SPEC principle 3 says limits are deterministic code. This adds the missing money limit.

Omnigent (Apache-2.0) adds the second half: a spend ceiling per run with a soft threshold that asks first and a hard cap that stops, and policies stacked from server to agent to session with the stricter checked first. It was first drafted as an addendum on WP-13; it now lives here so the money limit has one home.

## What exists today, so nothing stacks

- The usage history: per-turn tokens and `costUsd`, with turns that have no price counted apart (`history.ts`, `turnTotals`). It is the only meter.
- `builderLaunchAllowed(health, limits)` (`src/features/monos/model/builderScale.ts`) refuses a launch with a reason and never stops a running builder. The spend check is a second input to that gate, not a second gate.
- WP-11's wake queue and timers carry the warning and the period reset.
- `src/features/sessions/model/customModels.ts`: a custom model is one billed by its own provider; the router reads its route. Subscription CLIs are not billed per token, so they keep WP-13's rate-limit rules and are outside the per-task ceiling.
- WP-89's scopes (this Mono, this project, everything) and its caller rule decide who may set a limit.

## Build

1. **Check the meter before the setting.** For each CLI and login type Hivra drives, record whether a finished turn carries `costUsd`. Today Claude Code and opencode read it, and the others read none. A subscription login may report an API-equivalent figure or none. Find out on a real turn, and label the limit "measured cost", never "your bill". Put the table in the PR.
2. **Limits.** `{ scope: "project" | "app", period: "day" | "month", amountUsd, warnAt: 0.8 }`. Validate it (finite positive amount, known period, `warnAt` between 0.5 and 1). Store it with the project and app settings, and carry it through Export and import the way worker limits are. Import only adds.
3. **One pure check.** `spendAllowed(spent, limit)` returns `ok`, `warn`, `over`, `unmeasured` or `unset`, with a reason. It is called inside `builderLaunchAllowed` for every new builder, and again before a queued one starts. `over` reads: "Spend limit reached for <project>: $X of $Y this month. Raise it, or wait for the month to reset." `unmeasured` launches and says on the card that the CLI reports no cost, so the limit cannot count this work.
4. **Warn once.** Crossing `warnAt` wakes the project's first mate once per period, using the dedupe key WP-11 already uses, and writes one activity line (WP-78).
5. **Running work continues.** The limit refuses only new launches. Nothing is killed or refunded. A queued builder waits with its reason on the card, as WP-161 holds one.
6. **Period reset.** At the boundary, in the person's local time, the total restarts and the pause lifts without a restart. The total is summed from the usage rows, not held in a counter, so a restart cannot clear it.
7. **On screen.** The project Workers dialog and Settings > Crew show one line: "Spent $12.40 of $50 this month (25%). New builders pause at $50." or "This CLI reports no cost, so this limit cannot count its work." A pause shows in Needs you, as WP-161's disk pause does, with one action: Raise limit.
8. **By chat.** `app tasks.workers` reads and sets a limit with WP-89's scope words and refusals. Only a first mate's own chat may set one. A worker, a habit run or the checker may not.
9. **Per-task ceiling on billed models (from Omnigent).** A run on a model its own provider bills (any custom model) can carry a spend ceiling per task, and a daily ceiling for unattended runs. Off unless the person sets one. At the soft threshold the person is asked once whether to continue. At the hard cap that run stops, the task is held for the person, and the reason is recorded on the task row. The daily total restarts at local midnight and is summed from the usage rows. It is checked at each turn end from the cost the CLI reports, so one turn can overshoot it.
10. **Reroute never spends on its own.** A reroute from a subscription limit (WP-13) never moves a task onto a billed model without the person's OK.
11. **Stacking.** When a task ceiling, a project limit and an app limit all apply, the stricter is checked first. Crew rules (WP-13) can set a per-task ceiling for a project.

## Don't

- Don't estimate cost from tokens with a price table here. That is a later package, and its figures would be guesses shown as spend.
- Don't count an unpriced turn as $0. An unmeasured limit says so and never passes silently.
- Don't stop, kill or refund running work because of the project or app limit. The one exception is the per-task hard cap on a billed model in step 9, which stops only that run and holds the task.
- Don't put a per-task ceiling on a subscription CLI. Its use is not billed per token, and WP-13's rate-limit rules cover it.
- Don't add a second gate, a second meter or a second settings screen.

## Honest limits

- A cap counts what the CLI reports. Where a CLI reports nothing, the limit says so and cannot protect that work.
- Spend is checked when a builder launches, not while it runs, so one large builder can overshoot the limit by its own cost. The per-task ceiling is checked at each turn end, so it can overshoot by one turn.
- The two sources disagree about a run in progress: Paperclip's design only refuses new launches, Omnigent's hard cap stops a run. This draft keeps both, at different scopes (project or app limit, never stops; per-task ceiling on billed models, stops that run). Ash to confirm.

## Licence

Ideas only, no code or text copied. The design uses Hivra's usage rows and WP-161's gate.

- Paperclip is MIT (its LICENSE file: "Copyright (c) 2025 Paperclip AI").
- Omnigent is Apache-2.0 (Copyright (2026) Databricks, Inc. per its NOTICE).

Both are credited in SOURCES.md and credits.json already; credit them again in the PR when this lands.

## Owned paths

- `scripts/fake-claude.mjs`
- `src-tauri/src/model_router.rs`
- `src/features/monos/model/builderScale.ts`
- `src/features/sessions/model/customModels.ts` (only to tell a billed model from a subscription one)
- `src/features/usage/model/history.ts`
- `src/integrations/harness/providers/claude/claude.ts`
- `src/integrations/harness/providers/opencode/opencode.ts`

## Done when

- [ ] Tests first: a priced turn adds to the total and an unpriced one is counted apart, never as $0; `spendAllowed` covers ok, warn, over, unmeasured and unset; the warning wakes once per period; a period boundary lifts the pause; a restart does not reset the total.
- [ ] Tests (per-task ceiling): the soft ask fires once, the hard cap stops that run and records why on the task row, the daily total resets at local midnight, and a reroute never moves a task to a billed model on its own.
- [ ] A refused launch shows its reason, and a running builder is never stopped (fake Claude in `scripts/fake-claude.mjs` with a fixture cost).
- [ ] The ceilings show on the task row and in Settings, and crew rules can set one per project.
- [ ] Export and import carry the limits, and import only adds.
- [ ] Browser spec (Chromium and WebKit): set a limit, see the line, see the pause in Needs you, raise it, and the queued builder starts.
- [ ] Dev-copy check on Ash's Mac with one real priced turn. The meter table from step 1 is in the PR.
- [ ] `npm run check` passes.
