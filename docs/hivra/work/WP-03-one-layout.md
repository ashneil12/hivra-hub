# WP-03: One layout

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| A | M | none | no |

## Goal

Hivra has exactly one layout. No switch in Settings, no invitation to try the other one.

## Why

Upstream added a second layout on 17 Oct 2026 ("Focused": project switcher, workspace tabs, right panel; commit
`5c388c4e`) next to "Classic". Ash: two views don't make sense for Hivra; use whichever performs best for how Hivra
is used.

## Read first

- `src/features/settings/model/appearance.ts` (`INSET_LAYOUT_KEY`, `INSET_LAYOUT_DEFAULT`, `loadInsetLayout`).
- `src/features/settings/ui/SettingsView.tsx` (the `inset-layout` control), `src/app/shell/NewLayoutNotice.tsx`.
- `src/app/App.tsx` (every `insetLayout` branch), upstream's `CHANGELOG.md` entries about "the new layout".
- `tests/browser/workspace-performance.spec.ts`, `tests/browser/layout-opt-in.spec.ts`.

## Build

1. **Measure both** on the same machine: upstream's `workspace-performance.spec.ts` numbers in each layout, and in
   a dev copy (`npm run hub:dev -- --seed`) the time to open a project, switch tabs, and scroll a long chat, plus
   idle CPU and memory. Write the numbers in the PR.
2. **Pick Focused** (upstream's direction: the right panel is where the Crew tab goes in WP-15) unless it is
   measurably slower. If it is, pick Classic and say why.
3. **Fix the choice in one place**: a Hivra constant that `loadInsetLayout` returns, ignoring the stored value.
   Remove the Settings control and the invitation from what Hivra renders. Leave upstream's code for the other
   layout in place, so upstream merges stay clean.
4. Check every Hub screen in the chosen layout in a browser spec and fix what breaks.
5. Upstream's `layout-opt-in.spec.ts` tests the switch that no longer exists: delete it in this PR and note it, so
   later upstream merges know to keep it deleted.

## Don't

- Don't delete upstream's other-layout code paths unless the measurements show a clear win from removing them.

## Done when

- [ ] Measurements for both layouts are in the PR, with the choice and the reason.
- [ ] No layout setting or invitation appears; the stored value is ignored.
- [ ] Browser specs cover the main screens in the chosen layout; `npm run check` passes.
- [ ] Dev-copy check on Ash's Mac: the app opens in the chosen layout with existing data.
