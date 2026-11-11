# WP-219: The Agents board, the whole tree

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | M | WP-213 (the rail's Agents tile; sub-chats leave the main screens), WP-218 (departments, optional: read memberships until it lands) | yes |

## Goal

One place shows every agent at work: the Chief of Staff (its Home session and each project's session), each project's
first mates, their crew and any sub-chats under them. Each row says its state, what it is doing, what it has cost, how
long it has run, and its pull request and checks. Any chat opens read-only with Stop. It is on by default and the rail's
**Agents** opens it.

## Why

Ash, 11 Nov 05:33: "you don't need to see al the chains of sub chats that each level Is managing outside of it being
visible in the agent dashboard for tracking work which is on as well by default." WP-213 takes sub-chats, model chips
and git counts off the project home and Home; this is where they go. In 0.16.15 the same agents showed in the sidebar's
orchestration list, the live agents preview, the Crew panel and a Page called Agents, each with different rows.

## Read first

- [UX.md](../UX.md) "The places" (Agents: "Not a place to manage work; the chats are").
- `orchestration/ui/*` (`OrchestrationSidebarAgents.tsx`, `OrchestrationPreview.tsx`), `sessions/ui/LiveAgentsPreview.tsx`,
  `crew/ui/CrewPanel.tsx`, `monos/ui/SubChatList.tsx`, the delegations store, the usage figures behind the status bar.

## Build

1. **The tree.** Chief of Staff at the top, with its Home session and one child per project session; under each
   project, its first mates (Coding first); under each first mate, its crew from the app's delegations, newest first;
   under a worker, its sub-chats. Collapsed below the first mates by default; expanding is remembered.
2. **A row.** The name (a project's name, never a folder path); a state chip (Needs you red, Working blue, Done green,
   idle grey); the task in a few words; cost so far; time running; and the pull request number with its checks ("3
   checks failing", "checks green") when there is one. Nothing else.
3. **Open read-only.** Clicking a row opens its chat with no composer and one **Stop** button that asks once. Talking to
   an agent happens in its own place (the captain's chat, a first mate's side chat), never here.
4. **Filters.** By project, and by state (Needs you, Working, Done today). Counts on the chips come from WP-210's
   needs and working lists, nothing else.
5. **One board.** The rail's Agents tile opens it; the sidebar's orchestration list and the Agents Page point here and
   stop rendering their own trees in the Hub bundle. On by default: no setting hides it.

## Done when

- [ ] Tests:
  - the tree nests captain sessions, first mates, crew and sub-chats from the real stores, with none twice;
  - each row shows a name not a path, and its state, cost, time and checks from their sources;
  - a row opens read-only with Stop and no composer, and Stop asks once;
  - the filter counts equal WP-210's needs and working counts;
  - the rail's Agents tile opens the board and no other Hub screen renders its own agent tree.
- [ ] Browser spec `tests/browser/wp219-agents-board.spec.ts` with example data: the tree expanded, a filter, a
  read-only chat with Stop, with 1440 × 900 screenshots.
- [ ] Before and after screenshots in the PR (example data); the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-219/`, never pushed).
- [ ] `npm run check` passes.
