# WP-210: One Needs-you list that every count reads

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | L | none (WP-14 and WP-40 are merged) | yes |

## Goal

One function builds the list of everything that needs Ash, across every project, and every number on screen counts
that list. The rail's red count on a project, the Home sidebar's Needs you count, Home's Needs you section, a
project's header chip, a Mono's red line and the Needs you screen (WP-211) always agree, and answering an item
anywhere clears it everywhere.

## Why

Ash, 11 Nov: "visually nothing makes sense". In 0.16.15 Home said "All quiet." under a red Needs you, the Inbox dot
counted tracker items only, and a project's rail badge counted mock data. About twelve modules each decide
"needs you" on their own. [UX.md](../UX.md) "One list" is the rule this package makes true.

## Read first

- [UX.md](../UX.md) and the mockups in [ux/mockups/](../ux/mockups/) (`Main.png`, `NeedsYou.png`, `Project.png`:
  the counts on all three agree on purpose).
- `src/features/hub/model/needsYouRows.ts` and `useNeedsYouRows.ts`: today's one list, **for workers only**
  (stopped workers and failed Leads). The rail's Mono section and `StuckPanel` already read it. Grow from here; do not
  start a second worker list.
- The other counters this package replaces (read each, list it in the PR, and switch it or delete it):
  - `hub/model/todayCounts.ts` `attentionCount` (the rail badge in `hub/ui/ProjectStrip.tsx`);
  - `hub/model/waiting.ts` `waitingOnAsh` / `waitingCount` / `MAX_NEEDS`;
  - `hub/model/waitingChats.ts` (`waitingChats`, `gateLog`, `answerPermission`) and `chatQuestions.ts`
    (`NEEDS_REASONS`, `needsReason`);
  - `hub/model/inboxCountNote.ts` (what an agent is told about the inbox count) and `inbox/hooks/useInboxUnseen.ts`
    (the Inbox dot in `app/shell/Sidebar.tsx`);
  - `home/model/lines.ts` and `home/model/load.ts` (Home's Needs you lines), `chief/model/homeReadings.ts`;
  - `hub/model/statusChip.ts`, `hub/ui/StatusMark.tsx`, `monos/model/stuckChip.ts`, `monos/model/workerStuck.ts`;
  - `hub/model/localHub/decisions.ts` (open decisions: needs and questions), `firstmate/model/steering.ts` (`Decision`);
  - the delivery gate's cards (`delivery-gate/ui/GateCards.tsx`) and the resume-stopped note (AGENTS.md "Restart-safe
    resume").
- The mock stores that feed badges today: `hub/model/hubWork.ts`, `hubBuilds`, `proposals`. Real data only.

## Build

1. **`src/features/needs/model/needsYou.ts`**: one pure function, `needsYou(sources, now): NeedsItem[]`, and one hook,
   `useNeedsYou()`, that feeds it live. A `NeedsItem` is:
   - `key`: stable across reloads (`<kind>:<source id>`), used to dedupe and to clear;
   - `kind`: `stopped` (a stopped worker, a failed Lead, a resume that stopped after 3 tries), `question` (an open
     decision or a chat's question to Ash), `approval` (a permission or red-line step in a chat, a Page or plugin asking
     for access), `merge` (work the coding team says is ready and waits on Ash's yes), `review` (a review request on a
     pull request in one of Ash's own projects' repos), `check` (a delivery or gate check that needs Ash);
   - `projectId` (or none for app-wide items), `who` (the Mono or "Coding team", by name, never an id), `at`;
   - `sentence`: one plain sentence a person would say ("frank wants to run `npm publish` in nibbii-web."), within
     140 characters;
   - `actions`: at most two, primary first, each the **same handler the source already has** (answer the decision,
     `answerPermission`, open the chat, the gate's own answer). This package adds no new way to act on anything, and in
     particular no new merge path: a `merge` item's primary action answers the coding team's own question.
   - `open`: where the item came from (chat, task, Page), so a click lands there.
2. **Sources.** Everything above, read through their existing stores. Worker rows come from `needsYouRows`. Decisions
   come from the decision store. Chat questions and permission asks come from `waitingChats`. Gate checks come from the
   delivery gate. Review requests come from the PR watch and tracker data, **only for repos that belong to one of
   Ash's projects** (an upstream or someone else's repo is never in the list).
3. **Dedupe.** One thing that waits on Ash is one item, even when two sources see it. Examples: a worker's question that
   its Lead passed to Ash, and that worker's stopped row; a gate key both in the decision store and the gate log. Write
   the rule down in the module's header and test each pair.
4. **Counts.** `needsCount(projectId?)` and `workingCount(projectId?)` (running workers, from the app's own open
   delegations) are the only counts. Switch every reader in "Read first" to them: rail tile badges, the Home sidebar,
   Home, the project header (WP-213 draws it; until then the existing project row), a Mono's red line, the Inbox dot
   (until WP-211 replaces the Inbox, the dot shows this count and the tracker feed no longer adds to it), and what
   `inboxCountNote` tells an agent. Delete each counter that has no reader left.
5. **No mock data in any count.** `hubWork`, `hubBuilds` and `proposals` placeholders never reach a badge or a list.
   If a screen still needs them for a browse-only preview, gate them behind the existing dev-preview flag.
6. **"All quiet."** may show only when `needsYou()` is empty. Grep for every place that says it or anything like it, and
   make each read the list.
7. **Live.** Answering an item anywhere removes it from every count within one render. Use the stores' existing change
   events (`tasks://changed`, `local-hub://changed`, the decision and delegation stores) rather than a timer.

## Done when

- [ ] Unit tests (`needsYou.test.ts`) with one seeded item of every kind across three projects:
  - every count function agrees with the list, per project and in total;
  - each dedupe pair gives one item;
  - answering through each kind's own handler removes it;
  - a review request on a repo that is not one of the projects' repos is not in the list;
  - mock stores contribute nothing.
- [ ] A test that fails if a new module computes its own "needs you" count: grep the source for the old exported names
  (`attentionCount`, `waitingCount` and the rest you removed) and fail on any import of them.
- [ ] Browser spec `tests/browser/wp210-one-needs-list.spec.ts`, seeded with example data like `NeedsYou.png`
  (2 + 1 + 1 + 1 across Hivra, EXO, Nibbii and SafeTube). It reads the rail badges, the Home sidebar count, Home's
  section count and a project's count from one page and asserts they agree. It then answers one item and asserts every
  count drops by one. It takes 1440 × 900 screenshots before and after.
- [ ] Before and after screenshots of the rail and Home in the PR (example data), plus the same in a seeded dev copy
  kept on the Mac (`~/Worktrees/ux-shots/WP-210/`, never pushed: they hold Ash's chats). See [UX.md](../UX.md) "How a
  UI change is checked".
- [ ] `npm run check` passes.
