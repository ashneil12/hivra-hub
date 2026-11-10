# WP-142: Live model polish (new badge, notes, Fable 5.2)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Tonight finds (9 Nov 9pm) | S | none (WP-121 is mid-thread switch, not this) | yes |


## Goal

When a provider ships a new model, the hub picker shows it without needing a restart or a Hivra release, marks models first seen in the last seven days as "new", and keeps a short per-model note (for example when effort levels behave differently). The Claude fallback catalog and pricing labels include Claude Fable 5.2 when the CLI advertises it.

## Why

The 9 Nov 9pm X brief: T3 Code users saw Fable 5.2 in the picker without a restart on launch night. Anthropic shipped Claude Fable 5.2 at 18:58 UK; Cursor warned that Fable 5.2 effort levels behave differently from 5.1. Hivra already probes live `list_models` (`refreshClaudeCatalog` / `refreshHarnessCatalogs` on boot, active harness change, and picker refresh via `modelSource.ts`). WP-121 is mid-thread provider switch, not catalogue polish. Gaps left:

1. No "new" badge for models first seen recently.
2. No per-model note field for launch-night caveats.
3. Fallback catalog lists `claude:fable-5` / `claude-fable-5`, not a distinct Fable 5.2 entry; live discovery should already surface it when the CLI lists it, but offline / version-gated fallback should not lag a launch night.

## Read first

- `src/integrations/harness/providers/claude/claudeCatalog.ts` (`CLAUDE_MODEL_CATALOG`, `refreshClaudeCatalog`, `discoverClaudeModels`)
- `src/integrations/harness/core/registry.ts` (`refreshHarnessCatalogs`)
- `src/features/sessions/ui/modelSource.ts`, ModelPicker UI, `src/features/sessions/model/models.ts`, `olderVersions.ts`
- `crates/monocode-core/src/catalog/claude.rs` (mirrors the TS mapping)
- T3 behaviour (ideas only): live model list on launch night. Do not copy T3 source.

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-142-live-model-polish.md`. Add a `docs/hivra/SOURCES.md` row naming the 9 Nov T3 parity idea (live catalogue) and Anthropic's Fable 5.2 launch as product context. Ideas only; no credits.json component unless a later item translates code.
2. **Seen-at store.** Persist, per harness, the first local calendar day a model id was seen from a live catalogue. Models whose first-seen day is within the last seven days show a plain "new" badge in the picker. Tests for first see, ageing past seven days, and a model that only exists in the static fallback (no badge until live discovery sees it, or badge from the day the fallback was shipped if you choose that and document it).
3. **Per-model note.** A small optional note string on the catalog row (or a sibling map keyed by model id), editable only by Hivra releases / this package's seeded notes for known caveats. Seed one note for Fable 5.2: effort levels may behave differently from 5.1 (Cursor's public warning, attributed in SOURCES). Show the note under the model in the picker. Tests for presence and empty note.
4. **Fable 5.2 fallback.** Add `claude:fable-5-2` / native `claude-fable-5-2` (and display name "Claude Fable 5.2") to `CLAUDE_MODEL_CATALOG` and `models.ts` with the same effort / context controls as Fable 5, gated by the existing version helper pattern (`MINIMUM_CLAUDE_FABLE_*` or extend it). Keep older Fable entries in "Older versions". Mirror in `crates/monocode-core/src/catalog/claude.rs` only if that path hardcodes names (prefer live mapping). Tests: fallback contains 5.2; live `list_models` row for 5.2 still maps correctly; fold helper keeps newest Fable in the main list.
5. **Refresh honesty.** Keep using `refreshHarnessCatalogs` on active harness change and picker open. Do not add a polling loop that spawns CLIs every few seconds. If the picker is open, one refresh on open is enough; document that a brand-new model may need the picker reopened or the active harness to change once after the CLI learns it.
6. **Out of scope.** No mid-thread switch (WP-121). No Muse Ember (closed API). No restart of running sessions. Never read `~/.claude` settings, keys or auth.

## Done when

- [ ] A model first seen in the last seven days shows "new" in the picker; older ones do not.
- [ ] Fable 5.2 has a seeded note and appears in the Claude fallback catalog with version gating.
- [ ] Live `list_models` still wins when available; no busy poll.
- [ ] Browser or unit coverage for badge, note, and fallback id.

## After review (PR 131)

- The first live catalog a harness gives is a baseline: nothing in it is "new". A model a later live catalog adds is new for seven days from that day (`modelFirstSeen.ts`, `BASELINE_DAY`).
- A built-in list used because the CLI would not list its models fills the picker but is never recorded as live: `setHarnessModels(harness, models, { live: false })`. That covers Claude's version-filtered list and Grok's built-in list; every other harness records only what its CLI listed. The quick panel is not sent such a list.
- Opening the picker does not force a catalog read. A harness that already has a catalog is not probed again (`ModelPicker.probe.test.ts` opens the real picker several times and counts one read); Settings and the provider update notice still force one. A model the CLI learns later shows after a restart or a refresh from Settings.
- Fable 5.1 is in the built-in list and the Claude fallback. Its minimum, 2.1.255, is the CLI's own wording in the recorded `list_models` row ("Update to 2.1.255+ to use Fable 5.1"). Fable 5.2 has no minimum on record in this checkout. The 2.1.280 it was gated at is the Opus 5.5 gate from MonoCode (`MINIMUM_CLAUDE_OPUS_5_5_VERSION`), not a figure from another project and not a statement about Fable 5.2, so there is nothing to credit and the number is gone. The fallback offers 5.2 wherever it offers 5.1.

## Licence

Behaviour inspired by T3 Code's live model list (https://github.com/pingdotgg/t3code), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. Product context: Anthropic Claude Fable 5.2 launch, 9 Nov 2026. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
