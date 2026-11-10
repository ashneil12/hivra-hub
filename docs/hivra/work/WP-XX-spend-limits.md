# WP-XX: Spend limits, with a warning and no new builders at the limit

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Unassigned (Ash to place; no wave chosen) | M | 13, 78, 161 | yes |

## Goal

The person can set a spend limit, in dollars, for one project or for the whole app, for a day or a calendar month. At the warning share the project's first mate hears once. At the limit, new builders are refused with a plain reason, through the same launch gate WP-161 uses for machine health. A builder that is already running is never stopped.

## Why

Paperclip (MIT) describes budgets as tracking reported spend, alerting at thresholds and pausing work at configured limits. Hivra counts cost and never acts on it. The usage history adds up each turn's `costUsd` (`src/features/usage/model/history.ts`), and only the Claude Code and opencode adapters fill it (`src/integrations/harness/providers/claude/claude.ts`, `src/integrations/harness/providers/opencode/opencode.ts`). The limits Hivra does have are counts (Max builders in WP-161, worker limits in WP-13) and provider quota windows (WP-13 pauses on `resets_at`). No setting stops a project at a money figure, and API-key routes (`src-tauri/src/model_router.rs`) have no ceiling. SPEC principle 3 says limits are deterministic code. This adds the missing money limit.

## What exists today, so nothing stacks

- The usage history: per-turn tokens and `costUsd`, with turns that have no price counted apart (`history.ts`, `turnTotals`). It is the only meter.
- `builderLaunchAllowed(health, limits)` (`src/features/monos/model/builderScale.ts`) refuses a launch with a reason and never stops a running builder. The spend check is a second input to that gate, not a second gate.
- WP-11's wake queue and timers carry the warning and the period reset.
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

## Don't

- Don't estimate cost from tokens with a price table here. That is a later package, and its figures would be guesses shown as spend.
- Don't count an unpriced turn as $0. An unmeasured limit says so and never passes silently.
- Don't stop, kill or refund running work.
- Don't add a second gate, a second meter or a second settings screen.

## Honest limits

- A cap counts what the CLI reports. Where a CLI reports nothing, the limit says so and cannot protect that work.
- Spend is checked when a builder launches, not while it runs, so one large builder can overshoot the limit by its own cost.

## Licence

Idea only. Paperclip is MIT (its LICENSE file: "Copyright (c) 2025 Paperclip AI"). No code or text is copied. The design uses Hivra's usage rows and WP-161's gate. Credit it in SOURCES.md and credits.json when this lands.

## Owned paths

- `scripts/fake-claude.mjs`
- `src-tauri/src/model_router.rs`
- `src/features/monos/model/builderScale.ts`
- `src/features/usage/model/history.ts`
- `src/integrations/harness/providers/claude/claude.ts`
- `src/integrations/harness/providers/opencode/opencode.ts`

## Done when

- [ ] Tests first: a priced turn adds to the total and an unpriced one is counted apart, never as $0; `spendAllowed` covers ok, warn, over, unmeasured and unset; the warning wakes once per period; a period boundary lifts the pause; a restart does not reset the total.
- [ ] A refused launch shows its reason, and a running builder is never stopped (fake Claude in `scripts/fake-claude.mjs` with a fixture cost).
- [ ] Export and import carry the limits, and import only adds.
- [ ] Browser spec (Chromium and WebKit): set a limit, see the line, see the pause in Needs you, raise it, and the queued builder starts.
- [ ] Dev-copy check on Ash's Mac with one real priced turn. The meter table from step 1 is in the PR.
- [ ] `npm run check` passes.
