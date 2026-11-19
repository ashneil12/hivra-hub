# WP-187a: An ordered model chain for each kind of work

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 89 | yes |

From PLAN.md, "From oh-my-hermes", item 2 (per-lane model chains), merged with kitze's item 3 (an ordered fallback list
on a bot), because both are one ordered list of CLI, model and effort. oh-my-hermes is MIT (read at commit `2676c33`);
this package takes the idea only and is credited per SOURCES.md. Moving down the chain on a refusal is
[WP-187b](WP-187b-refused-model-moves-down-the-chain.md).

## Goal

The person (or a first mate, by chat) can give each kind of work an ordered chain: for deep work, Opus at high effort,
then GPT-5 on Codex at high, then Sonnet; for quick work, Haiku, then a cheap Codex model. A worker starts on the
first link that is installed, signed in and offered by the catalog, and its start card names the next link.

## What Hivra has

- `src-tauri/src/crew/resolve.rs` and its TypeScript twin `src/features/crew/model/resolve.ts`: one `Pick`
  (`cli`, `model`, `effort`) per field, with precedence override, brief, first matching rule, Mono default, project
  default, system default, usual (WP-89, `RouteDefaults`). `Route` records each field's source and `Skipped` values.
  Rules match labels or paths (`crew/rules.rs`, `first_match`).
- `crew/reroute.rs` `next_candidate`: after an account failure, the next installed and signed-in CLI in presence
  order, not a chosen chain.
- `src/features/crew/model/cliFallback.ts`: the plain line when a CLI is not installed.
- WP-182 (the Mono card) shows a chain once this lands.

## What to build

1. **Lanes.** Four fixed lane names: `deep`, `quick`, `review`, `visual`. `delegate_task` (`src-tauri/src/mcp_server.rs`)
   takes an optional `lane`; the first mate contract (`src/features/firstmate/contract.md`) gets one sentence on when
   to use each. No lane means today's behaviour.
2. **A chain** is an ordered list of up to five `Pick`s. It can be set per lane at three scopes, Mono, project and
   system, beside WP-89's defaults (same stores, same export and import). A crew rule may also carry a chain in place
   of one pick.
3. **Resolution.** `resolve_route` (Rust and TypeScript, kept in step by the existing twin tests) takes the lane. The
   override and the brief still win. Then a matching rule's chain, then the Mono's chain for the lane, the project's,
   the system's, then today's defaults. Within the chosen chain, the first link whose CLI is installed and signed in
   (`Presence`) and whose model and effort the catalog offers wins; skipped links go into `Skipped` with the reason.
   `Route` gains `chain` (the remaining links, in order) and `chain_from` (which scope set it).
4. **Where it shows.** Settings > Crew: a "Chains" block with one row per lane at system scope. The Mono card (WP-182)
   and the project's Workers popover: the same control at their scope. A worker's start card: "Runs on Opus 4.7, high
   effort (deep chain, set for this Mono). Next: GPT-5 on Codex." `app tasks.workers` gains `lane` and `chain` so a
   first mate can read and set them, with WP-89's caller checks.

## Rules

- Off by default: no chain is set, so every route is what it is today (a test compares routes byte for byte).
- Planning help and verdict checks keep their cheap model (`role_model`).
- No new outward network call. No change to approvals, permission modes or the protected-path list
  (`src/shared/security/agentConfigPaths.json`, when it exists).
- Credit oh-my-hermes (MIT) for the idea in the PR and update its row's package column in SOURCES.md.
- Upstream rules from PLAN.md: crew modules are Hivra's own; `mcp_server.rs` gets one new optional argument.

## Done when

- [ ] Red first: a twin test resolves a `deep` brief with a Mono chain of three links where the first CLI is not
      installed, and expects the second link with the first in `Skipped`; it fails before chains exist.
- [ ] Tests (Rust and TypeScript): precedence across all scopes; a rule's chain beats a Mono's; a model the catalog
      lacks is skipped with its reason; no lane and no chain gives today's route; export and import carry chains.
- [ ] Agent-app tests: read and set a chain per scope; refusals for a worker or habit caller and for an unknown model.
- [ ] Browser spec `tests/browser/crew-chains.spec.ts`: set a system chain, see a Mono override it, and the start
      card's "Next:" line. Screenshots in the PR.
- [ ] `npm run check` passes.

## Not in this package

Moving down the chain when a provider refuses (WP-187b). Choosing lanes automatically. Cost-based ordering.
