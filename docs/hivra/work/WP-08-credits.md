# WP-08: Credits and notices

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| A | S | none | yes |

## Goal

Every project Hivra learns from is credited where people look: the README, the root `NOTICE`, and an About or
Credits screen in the app.

## Why

Ash wants the inspirations shown openly, and the licences of anything vendored require it.

## Read first

- [SOURCES.md](../SOURCES.md), the root `README.md` and `NOTICE`, `src/features/monos/model/monoTree.NOTICE.md`,
  `docs/community-components.md`.
- Settings' footer (`src/features/settings/ui/SettingsView.tsx`), where the build stamp shows.

## Build

1. README "Inspirations": one line per source in SOURCES.md that Hivra takes ideas or code from, with its link
   and what it gave. Keep the README short; link to SOURCES.md for detail.
2. `NOTICE`: an entry for each vendored component (today: UniiChat's tree, react-day-picker, Tremor BarList; add
   more as packages vendor them), with licence and copyright line.
3. A small Credits view reachable from Settings that renders the same list (read from a JSON file generated from
   SOURCES.md, or kept beside it, with a test that the two agree).

## Done when

- [ ] README, NOTICE and the Credits view list the same sources; a test fails if they drift.
- [ ] `npm run check` passes.
