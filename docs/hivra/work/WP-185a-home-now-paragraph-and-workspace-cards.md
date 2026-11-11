# WP-185a: Home says what is going on now in one paragraph, and shows a card per workspace

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 73, 88 | yes |

From PLAN.md, "Ideas from kitze's factory teaser", item 6 (the paragraph and the workspace cards). To-dos and the
scratchpad are [WP-185b](WP-185b-home-todos-and-scratchpad.md). Ideas only, nothing credited.

## Goal

At the top of Home, one short paragraph in plain words says what is going on right now: "Four agents are working in
two projects. Three decisions are waiting on you. One pull request is ready to merge." It is written by code from
what Home already loaded, so it is live and never makes anything up. The projects section can show as cards, one per
workspace, each with its name and the one thing happening there.

## What Hivra has

- Home (`src/features/home/`): sections `needs-you`, `projects`, `moving-now`, `recent` (`BUILTINS` in
  `model/arrangement.ts`), movable and hideable, panels can be pinned; `fetchHome` in `model/load.ts` loads projects,
  decisions, tasks, docs and chats into a `HomeSnapshot`; `projectLines` in `model/lines.ts` already gives one line
  per project with no counts.
- WP-88: the Chief of Staff's morning summary on Home (`src/features/chief/model/summary.ts`, `summaryLines`), written
  by a model once a day and shown only when each line cites a reading.
- **WP-73 rule 6:** no counters, charts, badges or status chips on Home. Plain words and links only.

## What to build

1. **The paragraph** (`model/nowParagraph.ts`, pure): `nowParagraph(snapshot, liveWorkers)` returns at most three
   sentences, each built from one fact and each a link: agents working (from WP-15's crew rows across projects),
   decisions and questions waiting on the person (the Needs you lines), work ready for review or to merge (tasks in
   review, green pull requests from the PR watch). Numbers are written as words up to ten ("four agents"), digits
   above. A fact that is zero is left out; all zero gives "All quiet." The sentences are fixed templates, not model
   prose. This is the plain-language paragraph WP-73 rule 6 allows; it is not a counter, so it has no badge, chip or
   box around a number.
2. **A `now` section** added to `BUILTINS`, first in the default order, movable and hideable like the rest. An
   existing saved arrangement gets it at the top (the rule that puts a missing built-in back).
3. **Workspace cards.** The `projects` section gains a "Show as cards" choice (kept in the arrangement). A card is the
   project's name, its logo if it has one (`project_logo.rs`), and the same one line `projectLines` gives. No numbers.
4. **Numbers on cards, behind a setting.** Settings > Home > "Show numbers on Home", off by default. When on, a card
   adds "3 working · 1 waiting on you". The setting's help says that Home normally shows no numbers on purpose.
5. Updates live on the events Home already listens to (`tasks://changed`, `local-hub://changed`, decisions).

## Rules

- Off by default for numbers on cards. The paragraph uses words and links only, no counter styling.
- No model call. The WP-88 morning summary stays separate and unchanged.
- No new outward network call.
- Never weakens existing approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it
  exists).
- Upstream rules from PLAN.md: new files in `src/features/home/model/`; `HomeView.tsx` gets small hooks.

## Done when

- [ ] Red first: `nowParagraph` tests written before the function: zero of everything gives "All quiet."; four
      workers in two projects; eleven decisions gives digits; each sentence carries its link target.
- [ ] Test: an old saved arrangement gains `now` at the top and keeps its order otherwise; `now` can be hidden.
- [ ] Test: cards show no digit when the setting is off (a regex over the rendered card text).
- [ ] Browser spec `tests/browser/home-now.spec.ts` with seeded data: the paragraph, a sentence link opening the
      right place, a worker finishing and the paragraph changing live, cards on and off, numbers only with the setting.
      Screenshots in the PR.
- [ ] `npm run check` passes.

## Not in this package

To-dos and the scratchpad (WP-185b). Charts. A day view (WP-186). Changing the Chief's summary.
