# WP-182: A Mono's settings on one card, with fast mode and its own skills and commands

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 89 (187a to show the fallback chain) | yes |

From PLAN.md, "Ideas from kitze's factory teaser", item 3 ("agents as bots"). The ordered fallback list is merged
into [WP-187a](WP-187a-model-chain-per-kind-of-work.md), because it is the same mechanism as oh-my-hermes's lane
chains; this card shows it. Ideas only, nothing credited.

## Goal

Each Mono has one card that shows and edits everything that makes it what it is: role, the CLI and model its own
chat runs on, effort, fast mode, what its workers run on, its fallback chain, and the skills and slash commands it is
offered. Today these live in four places.

## What Hivra has

- `src/features/monos/model/mono.ts`: `Mono` with `role`, `engine` and `engineModel` (`MonoEngine`), `crewRules`
  (WP-21), `workerDefault` (WP-89, `WorkerPick`), `everyProject` (WP-88). `monoRole` gives the shown role.
- `src/features/monos/ui/MonoSettingsDialog.tsx` and `MonoModelLine.tsx`: name, role and engine. The worker default
  sits in its own control (WP-89, `src/features/crew/model/workerDefault.ts`). Crew rules are in Settings > Crew.
- Fast mode exists per model: the launch id carries it (`claude-opus-4-8[effort=high,fast=false]`,
  `src/features/sessions/model/models.ts`) and `claudeLaunch.ts` sets `flags.fastMode`. A Mono cannot set it.
- Skills: `src-tauri/src/skills.rs` (`list_skills`, `DiscoveredSkill` with `scope` and `source`); plugin commands are
  `commands/<name>.md` in a plugin's Hivra folder (`src-tauri/src/plugins/hivra.rs`). Every chat is offered the same
  pstack and mcode index (`sessionInstruction` in `src/features/plugins/model/pstackAutopilot.ts`).

## What to build

1. **The card** (`src/features/monos/ui/MonoCard.tsx`, new), opened from the Mono's header in place of the settings
   dialog's first page. Sections, each one line until opened: Role; Runs on (CLI, model, effort, fast); Its workers
   (WP-89's control, reused, with its "in force and why" line); Fallback (the WP-187a chain, read-only here until
   187a merges, then editable); Skills and commands.
2. **Fast mode on a Mono.** `Mono` gains `engineFast?: boolean`. Shown only when the chosen model offers it (the
   catalog in `models.ts` decides). It goes into the Mono's launch through the same `fast` setting the model picker
   uses, never a new flag.
3. **The Mono's own skills and commands.** `Mono` gains `skills?: string[]` and `commands?: string[]` (names, not
   paths). Empty or absent means today's behaviour: everything installed is offered. When set, the Mono's session
   instruction lists only those, in the same format as the pstack index, and the composer's slash picker for that
   Mono puts them first. Nothing is hidden from the person; a skill not on the list still works when named.
4. **Export and import** carry `engineFast`, `skills` and `commands` (`src/features/portable/model/setupDoc.ts`),
   import only adds, and an unknown skill name is kept with a "not installed here" note.
5. Each change on the card goes into the activity log (WP-78) as a Mono settings change.

## Rules

- Changes nothing for a Mono whose new fields are unset (tested).
- No new outward network call. No change to approvals, permission modes or the protected-path list
  (`src/shared/security/agentConfigPaths.json`, when it exists).
- A card edit never restarts a running turn; the next turn uses it (WP-89 rule 3).
- Upstream rules from PLAN.md: new files under `src/features/monos/ui/`; `MonoSettingsDialog.tsx` gets a hook, not a
  rewrite.

## Done when

- [ ] Red first: a test builds a Mono's session instruction with `skills: ["grill-me"]` and expects only that skill
      listed; it fails before the field exists.
- [ ] Tests: unset fields give today's instruction byte for byte; fast is dropped for a model without it; export and
      import round-trip the new fields; an unknown skill survives import with its note.
- [ ] Browser spec `tests/browser/mono-card.spec.ts`: the card's sections, setting fast on a model that has it and not
      seeing it on one that does not, picking skills, and the worker line from WP-89. Screenshots in the PR.
- [ ] `npm run check` passes.

## Not in this package

The fallback chain's engine (WP-187a and 187b). Writing new skills (Creator mode, WP-34). Per-Mono plugins.
