---
name: dropwave-ui
description: Change one of the app's own screens (sidebar, Home, a chat, Hubs, Settings, first run) so it still looks and behaves like the rest of Dropwave. Use before touching anything under src/ that a person sees, when asked to "move", "rename", "add a button", "fix how X looks", or when a first mate is asked to change the app it runs in.
---

# Changing the app's own screens

The rules are in [docs/hivra/DESIGN.md](../../../docs/hivra/DESIGN.md). Read sections 2 (words), 3 (layout) and 4
(rules) before you write anything. This skill is the order to work in.

## 0. Is it a screen change at all?
If the ask is "show me X" or "I want a board for Y", it is a hub, not an app change: use the `make-a-hub` skill. Only
change the app's code when the thing must be part of every install.

## 1. See it before you change it
- Find the screen in DESIGN.md section 5, open the file, and find the control by its `data-…` hook.
- Build the mockup (`npm run mockup:build`, about a minute), serve `target/mockup/` and open `mockup.html?reset`.
  Take a screenshot at 1440 by 900 of the screen as it is. That is your "before".
- If the bug only shows after a click elsewhere, reproduce that path first and screenshot it.

## 2. Change as little as possible
- Reuse: `Popover`, `Modal`, `ConfirmDelete`, `RailAction`, `SecondaryButton`, the icons in `src/shared/ui/icons.tsx`.
  If the screen you need already exists somewhere in another shape, copy that shape.
- Use the words in DESIGN.md section 2. Never put "Mono", an id or a code name in text a person reads.
- Tokens only for colour. One primary button per surface. A tick box on every row of a pick-several list.
- Keep every `data-…` hook and `aria-label`; when a control moves, move its hook with it and update the tests that
  use it (`rg "data-your-hook" src tests`).
- Guard a Dropwave-only change with `IS_HUB_BUNDLE` or `ONE_CHAT_LOOK` (`src/features/hub/model/hubBundle.ts`) when
  the same file also serves upstream MonoCode's layout. This repo must stay mergeable with upstream.
- State that must survive a relaunch goes in the app's stores, not `localStorage`. If you add any, add it to
  `docs/hivra/work/dropwave-wiring.md`.

## 3. Prove it
- A unit test beside the code for any rule you added (`src/**/x.test.ts`).
- `npx tsc --noEmit -p .` and `npx vitest run <the folders you touched>`; then `npm run check:web` once.
- Rebuild the mockup and take the "after" screenshot. Then walk around the change: open it from Home and from a
  project, switch projects, open a chat and come back. Look at the sidebar highlight each time: exactly one row is lit.
- A browser spec in `tests/browser/` for anything a person sees.

## 4. Hand it over
- A pull request that is ready for review (never a draft), with the before and after screenshots and one plain
  paragraph: what the person will notice, what you did not check and why.
- Example data only in screenshots and tests, each line starting "Example:". This repo is public.
- It reaches the owner's app only by `npm run hub:ship` from merged main (AGENTS.md). Never edit, quit or copy the
  installed app.

## Mistakes already made once
- A panel positioned by hand that only closed from its own button. Use `Popover` with `onDismiss`.
- A flyout measured once at a squeezed height that then "slid down". Placement goes through
  `src/shared/lib/popover.ts`.
- "New chat" beside a first mate opening a plain chat on another model. A chat started from a first mate is that
  first mate's (`startMonoSideChat`).
- Home showing the last project's teams. Ask `homeInView(selection)` before drawing anything that belongs to a project.
- Settings for a team sitting in the chat's side panel. Settings go in Settings.
