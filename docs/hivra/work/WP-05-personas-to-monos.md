# WP-05: Leadership personas become Mono templates

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | M | 10, 30 | no |

## Goal

The Chief of Staff, Projects Manager, frank, Alfred and Critiquito are ordinary Monos made from templates. No
code path treats them specially, and no prompt carries Ash-specific text.

## Why

Ash: every agent is a first mate with its own crew; the Hub's special leadership layer and its hand-tuned prompt
rounds made it robotic. SPEC.md sections 5 and 11.

## Read first

- `src/features/hub/model/builtInMonos.ts` (`BUILT_IN`, `TEAM_ADDONS`, `DEFAULT_TEAM`, `ADDON_OFFER`).
- `docs/leadership/*` (the persona files, `VERBATIM-GROK-CONFIG.md`, `ROOM.md`).
- `src/features/monos/model/leadFlow.ts`, `ashAnswersWorker.ts`, `hourlyCheck.ts`, `teamReport.ts`, and the
  `*.rNN.test.ts` files around them; `soulRefresh.ts` and `soulTamper.ts` (how seeded souls are kept and
  protected).
- WP-10's contract (the first mate prompt and brief) and WP-30's template contribution type.

## Build

1. Turn each built-in persona into a **Mono template** in the plugin format (WP-30): a soul (role, who it is,
   what it watches for, skills), default crew rules, optional habits. Ship them in one bundled plugin,
   "Starter Monos". Rewrite the text plainly; remove Ash's names, EXO, Grok Bot and round numbers.
2. Replace the special-cased code: anything that checks for these ids (`rg 'chief-of-staff|projects-manager|frank|alfred|critiquito' src src-tauri`)
   either goes or becomes a general rule that applies to every Mono.
3. Replace the Lead/Chief-of-Staff prompt layers with WP-10's first mate contract plus the Mono's soul. Keep the
   delegation mechanics untouched.
4. Existing installs keep their Monos and their edited souls: a soul a person edited is never overwritten
   (`soulTamper` already guards this; keep its tests).
5. Remove the prompt-round tests whose behaviour no longer exists, in the same PR as the code they test; keep every
   test of delegation mechanics.

## Don't

- Don't delete a person's Mono or its memory. Templates only change how new Monos are made.

## Done when

- [ ] No source file outside the Starter Monos plugin mentions the five persona ids or Ash-specific names.
- [ ] A fresh dev copy offers the starter Monos at first launch; adding one makes an ordinary Mono.
- [ ] An existing dev-copy Mono with an edited soul keeps it (test).
- [ ] `npm run check` passes.
