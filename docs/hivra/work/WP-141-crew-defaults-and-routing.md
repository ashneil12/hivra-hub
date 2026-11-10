# WP-141: Crew defaults screen and first-mate routing across Monos and CLIs

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity (Ash ask, 9 Nov 21:11 UK) | M | WP-120 (lead on any CLI); reuses WP-13 resolve/reroute and WP-89 worker defaults | yes |


## Goal

A person can set what the crew uses by default in one clear Settings screen, and the first mate can still pick the right worker for each task from everything available: installed CLIs, signed-in providers, and existing Monos. Every pick shows a short reason. The person can lock the default or ban a CLI or Mono. When one account runs out of quota, the fallback order the person set is used, and the switch is never silent.

## Why

Ash (9 Nov 21:11 UK): make it easy to choose what the crew uses by default, while the first mate can still delegate the right crew across available Monos and CLIs when needed. Today the pieces exist but are split: WP-89's `WorkerDefaultControl` (mono / project / system), WP-13's `CrewRulesPage` and `resolveRoute`, and account-failure reroute in `src-tauri/src/crew/reroute.rs`. There is no single defaults screen, no builder / reviewer / researcher role slots, no "always use my default" or "never use X" lock, no person-ordered fallback list in the UI, and no first-mate pick that can choose a Mono as well as a CLI with a visible reason. T3's model picker is strong for one thread; Hivra should win on crew defaults plus honest delegation.

## Read first

- Hivra (origin/main): `src/features/crew/README.md`, `model/resolve.ts` (`resolveRoute`, `roleModel`, `defaultCli`), `model/rules.ts`, `model/workerChoice.ts`, `model/cliFallback.ts`, `model/clis.ts` (`CLI_ORDER`), `ui/WorkerDefaultControl.tsx`, `ui/CrewRulesPage.tsx`, `src/features/settings/ui/SettingsView.tsx` (section `"crew"`), `src/features/monos/model/workerPool.ts`, `src-tauri/src/crew/{resolve,rules,reroute,mod}.rs`, `docs/hivra/work/WP-13-crew-routing.md`, `docs/hivra/work/WP-89-worker-model.md`, `docs/hivra/work/WP-21-monos-first-mates.md`, `docs/hivra/SPEC.md` section 4 step 3.
- Related drafts: WP-120 first-mate-any-cli, WP-121 mid-thread-switch, WP-122 subagent-lineage, WP-135 fan-out-compare in this pack. WP-120 must land (or be branched without file clash) so a non-Claude lead can attach the pick tools.
- T3 behaviour (ideas only): model picker and mid-thread switch ([T3-PARITY.md](../T3-PARITY.md), portable handoffs). Do not copy T3 source. Ideas need no credits.json component.

## Design (do not invent a parallel router)

Keep one resolver. Extend what WP-13 and WP-89 already do.

### 1. Crew Defaults screen

In Settings, section `"crew"`, put a new **Crew Defaults** block above `CrewRulesPage`:

- One default CLI and model (and optional effort) for crew work. Wire it to the existing system (and, when a project is open, project) worker default through `WorkerDefaultControl` / `workerPool`. Do not add a second store.
- Optional per-role overrides for three fixed roles the first mate already labels: **builder**, **reviewer**, **researcher**. Implement each as a person-owned `CrewRule` with that single label (reuse `rules.ts` / Rust `crew/rules.rs`). The UI shows three simple rows, not the full rules editor. Advanced path rules stay on `CrewRulesPage`.
- One sentence of what is in force (reuse `inForceSentence` / `crewRuleSentence`).

### 2. First-mate pick across CLIs and Monos

Add a pure pick helper (TypeScript + matching Rust, same inputs) used when the first mate briefs a worker:

- Candidate pool: every installed and signed-in CLI from presence; every configured provider the catalog already knows; every existing Mono the person has (as a nested first mate, depth capped at 2 per WP-10 / WP-21). A Mono that is itself the lead of this chat is not a candidate for its own brief.
- Score by: role or label fit (crew rules / role slots), then availability (not already at the project worker cap, not paused on quota), then the person's fallback order, then today's `defaultCli`.
- Return `{ cli or monoId, model?, effort?, reason }` where `reason` is a short plain sentence, for example "builder role prefers Codex" or "Claude Code at quota; next is Grok". Persist the reason on the delegation / crew row so the Crew tab and the lead chat can show it. No silent pick.
- Per-task override and an explicit brief pick still win (existing `RouteTask.override` / `brief`). The first mate may set override only when the person has not locked the default.

### 3. Locks

Stored with the same worker-default / crew settings (project then system; Mono keeps its own):

- **Always use my default.** When on, the first mate must not set a per-task override that changes CLI, model or Mono away from the resolved default (including role slots). The person's own Settings change and the composer picker still work. Mid-thread switch (WP-121) stays a person action.
- **Never use.** A list of CLI ids and/or Mono ids. Filtered out of `resolveRoute` candidates, the first-mate pick pool, and `next_candidate` reroute. A rule or default that names a banned CLI is skipped with a visible reason (extend `skipped`), not applied quietly.

### 4. Fallback order

- A person-ordered list of CLI ids (subset of `CLI_ORDER`, only those installed). Shown and editable on the Crew Defaults screen.
- `reroute::next_candidate` (and the TypeScript twin if any) walks this list instead of raw presence order. Banned and unsigned-in entries are skipped with reasons on the attempt ledger.
- If **Always use my default** is on and the default CLI cannot take the work, do not invent another CLI: pause on `resets_at` when known, otherwise wake the first mate with the reason. That keeps the lock honest.
- Every fallback writes the same style of sentence as `cliFallbackLine` / reroute `reason`. Never change provider or CLI without a visible line.

### 5. Out of scope

- No new secret or vault path. No phone app. No auto-spend on a provider the person has not signed in. Do not rebuild the Crew tab (WP-15 / WP-119). Do not replace `CrewRulesPage`. Do not attach lead tools (that is WP-120). Do not copy T3 Connect, Clerk, telemetry, or the T3 name.

## Build

1. Add `docs/hivra/work/WP-141-crew-defaults-and-routing.md` (this file) and a `docs/hivra/SOURCES.md` row noting the Ash product ask and that behaviour builds on WP-13 / WP-89; mention T3 model-picker inspiration only as ideas. Commit once the doc and source note exist.
2. Settings: Crew Defaults block (default CLI + model, three role rows, Always use my default, Never use, Fallback order). Reuse `WorkerDefaultControl` and person `CrewRule` storage. Tests for load/save/sanitize; browser spec on Chromium and WebKit for the screen and the in-force sentence.
3. Extend `resolveRoute` / Rust resolve to honour Never use (skip + reason) and to treat the three role labels as ordinary rules already covered by `firstMatch`. Tests for ban, role slot, and precedence with the lock off.
4. First-mate pick helper: candidates from CLIs + Monos, score, reason string, depth-2 Mono nesting. Tests with stubbed presence, roster and caps. Wire the reason onto the crew / delegation row the UI already shows.
5. Fallback order store + `next_candidate` uses it; Always use my default blocks silent reroute. Tests for ordered fallback, ban interaction, lock-plus-quota pause / first-mate wake. No silent provider switch in any path.

## Done when

- [x] One Settings screen sets default CLI/model, optional builder/reviewer/researcher overrides, locks, and fallback order.
- [x] First-mate pick can choose a CLI or an existing Mono, with a short visible reason on the crew row. The first mate asks with `tasks.pick` (any CLI that can lead, through the app tool); `delegate_task` keeps the route's reason as `why` on the row's recorded line, returns it as `crewWhy`, and the Crew tab shows it.
- [x] Always use my default and Never use are enforced in resolve and reroute; quota fallback follows the person's order and is never silent.
- [x] No second router or second defaults store. Browser specs green on Chromium and WebKit for the new controls.
- [x] WP-120's lead-capability table is not regressively limited to Claude (coordinate if both are open).

## Licence

Product behaviour. Builds on Hivra WP-13 and WP-89. Ideas only from T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. Do not copy T3 source unless a later item explicitly says to; then add the file header, NOTICE, credits.json, README inspirations, and SOURCES.md row. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
