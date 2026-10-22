# Community components in the hub

Blocks in Pages (and screens a Mono builds) can reuse open-source components instead of being drawn from scratch.
Every one of them is restyled to the hub's theme tokens, so a scheme or a theme file restyles it with the rest of the
app. The how-to for agents is the skill `find-components` (`.agents/skills/find-components/SKILL.md` in this repo, and
**Add** on Settings → Skills → Ready-made puts it in `~/.agents/skills` so every project's Monos have it); this page
lists what is in use.

## In use

| Block | Component | Repo | Licence | How it's taken | Where |
|---|---|---|---|---|---|
| Calendar | `DayPicker` | [gpbl/react-day-picker](https://github.com/gpbl/react-day-picker) | MIT | npm package, `react-day-picker` 10.x (pulls in `date-fns`) | `src/features/pages/ui/CalendarBlock.tsx` |
| Bar list | `BarList` | [tremorlabs/tremor](https://github.com/tremorlabs/tremor) | Apache-2.0 | Restyled copy, no package | `Block` in `src/features/pages/ui/PagesView.tsx` |

## The rules each one follows

- **No CSS of its own.** react-day-picker's `style.css` is not imported. Every part gets classes through its
  `classNames` prop, using tokens only: `text-content` (small text at `/60` or above), `bg-theme-accent/20` for marked
  days, `ring-theme-accent/40` for their edge. No hard-coded colours.
- **Read-only unless the block needs input.** The calendar has no navigation and no selection: it shows the month the
  block names and its marked days. A marked day's note is its tooltip and is also listed under the month.
- **A safe fallback.** If the block's `month` isn't a month and year ("October 2026"), the plain grid from the block's
  own `firstWeekday` and `days` is drawn instead, so an older or odd page still shows.
- **Licence kept.** The file header names the repo and licence.

## Adding another

1. Check the hub's own blocks first, then follow the `find-components` skill.
2. MIT or Apache-2.0 only, maintained in the last year, zero or one extra dependency.
3. Restyle to tokens, add a test that it draws with the theme classes, and add a row to the table above.
