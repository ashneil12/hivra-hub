---
name: hub-taste
description: Make a hub, a Settings screen or any app screen look designed rather than assembled. Use before building or restyling a hub (ready-made or a first mate's), a list, a dashboard or a panel in this app, and before calling a UI change done.
---

# Hub taste

Hubs are **Operate** surfaces: the owner is in a task (see who needs him, answer, open, stop). The bar is a tool that
disappears into the task, like Linear, Things or the macOS Settings app. Taste here is precision and restraint, not
decoration. This skill is the short list; the deep rules live in the borrowed skills (`.agents/skills/CREDITS.md`).

## 1. Read the screen first
Screenshot what is there (a browser fixture in `tests/browser/`, or a dev copy). Say in one line what the owner comes
to this screen to do. Everything on it either serves that or goes.

## 2. Layout: group with space, not boxes
- One column. Sections are a small heading and rows; the gap between sections is at least twice the gap inside one.
- Rows sit on the page, divided by hairlines (`--color-stroke`). A surface (`k-card`) only where one group must stand
  apart from the rest (Needs you). Never a card inside a card, never a grid of same-size cards as the page structure.
- No hero numbers. A big number with a small label above the list is the stock AI dashboard; say the counts in one
  quiet line instead, and put the count beside each section's heading.
- A row reads left to right in order of importance: state, name, what it is doing, time, buttons. Identity leads;
  metadata and actions trail. Columns line up across rows.
- Work under a row is indented under the name, with a hairline rail, at a smaller size.

## 3. Type
- The app's sans only, 13px for names and body, 12px for what sits under, 11px for tags; weight 500 for names, 400 for
  the rest. Numbers that change (times, counts) are `tabular-nums`.
- Never a title repeated inside the hub, never an eyebrow label over a heading, never all caps.

## 4. Colour
- Neutral by default. The three status colours appear only where a state is real: green working, amber asking,
  the Needs you red only when the owner must act. Colour never carries meaning alone: a word or glyph goes with it.
- Small text at 60% of `--color-content` or more. No accent text on neutral buttons; one filled primary per surface.
- No coloured left border on callouts or rows, no gradient text, no glow.

## 5. State glyphs and icons
- A row's state is a 14px glyph (`kit.glyph(state)`): a ring for idle, a turning arc for working, a filled amber dot
  for asking, a red mark for Needs you, a tick for done. Same glyph, same meaning, on every hub.
- Icons come from `kit.icon` only, stroke 1.75, `currentColor`. No emoji or Unicode stand-ins.

## 6. Controls
- Row buttons are quiet text buttons. Secondary ones show on row hover and keyboard focus (`k-reveal`); the one
  that answers the row (Answer) stays visible. More than three actions on a row means some belong in the opened chat.
- Pressed buttons scale to 0.96 over 150ms; hover changes background only, under `@media (hover: hover)`.
- Every control keeps its `data-` hook and an `aria-label` naming whom it acts on ("Open EXO lead").

## 7. Motion
- 150 to 200ms on background and opacity. Motion only for state (the working arc turns; nothing else animates).
- Everything moving is gated by `prefers-reduced-motion`.

## 8. Empty, loading, error
- Empty is one sentence that says what will appear here and when ("No agents yet. Your first mates show here once
  they're on the team.").
- Loading is one quiet line, never a spinner in the middle. An error says what could not be read and what to tap.

## 9. Before you call it done
Look at the render at 1100px and 560px, in a dark and a light theme, with a long name and with nothing in it.
Check: columns line up, nothing wraps or sticks out, small text is readable, one primary, counts agree with the rows,
no hero numbers, no card soup, no coloured side borders. Put before and after screenshots in the PR.

## Deeper rules
`better-layout` (grouping, alignment), `better-typography`, `better-colors` (contrast, one colour one meaning),
`better-ui` (radius, shadows, press, icons), `better-accessibility`, `better-writing`, `emil-design-eng` (motion and
polish), `frontend-design` (for a page with its own look, not an app screen). `better-interface` runs all of them as
one review.
