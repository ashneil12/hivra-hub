---
name: make-a-hub
description: Build the owner a page (a "hub": a board, tracker, dashboard, doc list or small tool) inside the app without changing the app's code. Use when they say "make me a page", "a hub for X", "show me X somewhere", "I want a board/tracker/dashboard", or when you notice you keep answering the same status question by hand.
---

# Make a hub

A hub is a small screen you build, the owner previews, and keeps with one tap (the code and the `page_build` tool
still call it a page). It lives under Hubs, can be
pinned to the sidebar, and belongs to one project or to none. It is the way to add to the app without touching its
code, so reach for it first. Changing one that already exists is the `editing-a-dashboard` skill.

## 1. Decide what it is for, in one sentence
"Shows every open launch task for Nibbii with who has it." If you need "and", it is two pages. Ask the owner only if
you cannot tell which project it belongs to.

## 2. Read the real data first
Use what you can already read: the project's board and memory, its repository, your own chats and delegated work. A
page shows real rows or an honest empty line ("Nothing here yet"). A page with made-up or example data is turned down.

## 3. Build it from blocks when blocks can show it
- The app's own blocks: `status`, `list`, `chart`, `barlist`, `note`, `calendar`. 1 to 12 blocks, each with a title.
  They already follow the theme and the three status colours.
- Send it from your own chat with `page_build {project, spec}`. The owner sees the preview on Hubs with Apply and
  Discard. After they say it looks good, keep it with `page_build {previewId, keep}`, or they tap Keep.
- Go bespoke (`html`, `css`, `js`, `permissions`) only when blocks cannot do it. A bespoke page runs in a sandbox: no
  storage, no cookies, no network of its own. List every read and tap it makes in `permissions`; one it does not list
  is refused, and one it lists but does not use is a reason not to allow it. The reads, taps and web-source rules are
  in `editing-a-dashboard` sections 3 and 4.
- Need a calendar, table or chart the blocks do not have? Use the `find-components` skill before writing one.

## 4. Make it look like the app: build it from the hub kit
A bespoke hub already has the kit: its styles (`k-page`, `k-stats`, `k-section`, `k-card`, `k-row`, `k-tile`,
`k-avatar`, `k-pill`, `k-btn`, `k-callout`, `k-empty` and the rest) and a `kit` global of builders (`kit.row`,
`kit.avatar`, `kit.pill`, `kit.stat`, `kit.button`, `kit.empty`, `kit.icon`, ...). Read docs/hivra/HUB-KIT.md and
build from those parts; the ready-made Agents hub (`src/features/pages/model/readyPages.ts`) is the worked example.
- Read the `hub-taste` skill first and follow it: one quiet line of counts, titled sections of rows on the page (a
  state glyph, the name with what it is doing, the state word and time, buttons that show on hover), the work under a
  row nested under it, and a card only for the group that must stand apart.
- Write your own CSS only for what the kit has no part for, with the theme tokens only (`--color-content`,
  `--color-surface`, `--color-surface-raised`, `--color-stroke`, `--color-theme-accent`, the three status colours).
- Small text at 60% or more, one primary button, no title repeated as an `h1` (the frame draws it), no colour outside a
  real status, and one sentence (`kit.empty`) when there is nothing.
- The words are the app's words: first mate, Needs you, Working, Stopped, Done (docs/hivra/DESIGN.md section 2).

## 5. Hand it back
One line: what the page shows and where it is. Offer to pin it only if they will open it every day. Do not ask for
anything else: the preview and the Keep tap are the approval.

## What a hub cannot do
Change the sidebar, Settings, keys, another first mate, or the app's core screens. If the ask needs that, say so and
point at the `dropwave-ui` skill, which goes through a branch, a review and a ship.
