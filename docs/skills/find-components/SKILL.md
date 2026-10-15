---
name: find-components
description: Find a ready-made UI component (calendar, chart, table, date picker…) in an open-source component repo, check it fits, and restyle it to the hub's theme tokens before using it. Use before building any non-trivial block for a Page or a hub change from scratch.
---

# Find a component, then make it ours

Draft skill. Agents reuse good open-source components instead of rebuilding them, and every reused component
follows the active theme so a new scheme restyles it with no extra edits.

## 1. Look before you build
- Search, in this order:
  1. The hub's own blocks: `src/features/pages/ui/PagesView.tsx` (status, list, chart, note, calendar). Reuse these when they fit.
  2. The starting repos below.
  3. GitHub search: `<component> react tailwind` with `stars:>500 pushed:>` within the last 12 months.
- Skip a repo that is archived, has no licence, or has not been touched in over a year.

## 2. Read the repo's design philosophy first
Open its README and docs intro and write down, in one line each:
- **How it's delivered:** copy-in source (you own the code) or an npm package (you take its updates).
- **How it's styled:** Tailwind classes, CSS variables, or CSS-in-JS. Only Tailwind or CSS variables fit the hub.
- **What it pulls in:** extra libraries (e.g. Radix, date-fns). Prefer components with zero or one dependency.
- **Licence:** MIT or Apache-2.0 only. Keep the notice in the copied file's header.

## 3. Pick one component
Choose the smallest component that does the job. Prefer copy-in source over a new package, so it can be restyled.
Write in the PR or Bot changes line which repo, file and commit it came from.

## 4. Restyle it to hub tokens (required)
Replace every hard-coded colour, surface, border and shadow with theme tokens:

| Theirs | Ours |
|---|---|
| background / card | `bg-surface`, raised: `bg-surface-raised` |
| border / ring | `ring-surface-ring`, dividers: `border-stroke` |
| text / muted text | `text-content`, `text-content/70`; small text never below `text-content/60` |
| primary / accent | `bg-theme-accent/…` (monochrome by default; a scheme may colour it) |
| success / warning / error | `bg-status-ok`, `bg-status-warn`, `bg-status-bad`: status only, never decoration |
| selected / hover | `bg-selection`, `bg-selection-hover` |

Then check:
- `rg -n '#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|(bg|text|ring|border)-(red|green|blue|amber|emerald|sky|rose|fuchsia|violet)-' <file>` returns nothing.
- It looks right in all three shipped schemes (Settings → Appearance → Scheme: Glass, Graphite, Dusk).
- Any fake data in it is labelled **Example data**.

## Starting repos (checked 15 Oct 2026)
- **shadcn-ui/ui**: https://github.com/shadcn-ui/ui (MIT, about 125k stars). Copy-in React and Tailwind components themed by CSS variables. Calendar, table, chart (built on Recharts), date picker. The closest fit, because its tokens map one-to-one onto ours.
- **recharts/recharts**: https://github.com/recharts/recharts (MIT, about 27k stars). An npm chart library. Colours are passed as props, so give it `var(--color-theme-accent)` and the status tokens.
- **tremorlabs/tremor**: https://github.com/tremorlabs/tremor (Apache-2.0). Copy-in dashboard blocks (KPI cards, bar lists, charts) built on Tailwind and Recharts. Good for Page blocks. Its default palette is colourful, so restyle it strictly to the tokens.
