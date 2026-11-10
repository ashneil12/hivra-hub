# WP-119: A live first-mate and crew tree, and a waiting-on-me Inbox order

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M | M | none | yes |

## Goal

Two views, written fresh in Hivra:

1. A live tree of a first-mate session: the first mate at the root, each crew worker (and any subagent that session has already recorded) as a child node, and the tool calls currently running or just finished inspectable from a node. It is built from Hivra's own session and crew records, not from a third-party hook or log scraper.
2. The first-mate side of the Inbox (decisions, questions, credential and permission asks, and other "this is waiting on you" rows) is one list: questions first, then the rest, and within each group the longest wait first, with the wait shown in plain words. A click opens the chat or worker.

## Why

A 9 Nov find: [ccdeck](https://github.com/BarganConstantin/ccdeck) (AGPL-3.0, 30 stars, created June 2026, still pushed 9 Nov). It is a local dashboard for Claude Code and Codex. Two ideas matter, and only the ideas:

- An agent session is a tree, but a transcript is a scroll. ccdeck draws the tree: the main agent at the root, subagents as nodes, tool calls that light up while they run, and a double-click that shows that node's prompt, tool calls and timing.
- Sessions waiting on the person sit in one queue, questions (and other blocks on a human) first, longest wait first, with the wait visible, and a way to jump to the oldest.

Hivra already has a flat crew tab ("one plain row per worker", `CrewTab.tsx`), a first-mate Inbox that ranks kinds as decision, then credential, then failure, then review, and then sorts by `updatedAt` (`src/features/crew/model/inbox.ts`), and a "Waiting on you" list of chats that asked a question (`waitingChats.ts`). Tool calls already appear in the transcript scroll (`AgentTranscript.tsx`). Devin subagents can appear in agent cards. What is missing is a live tree of first mate, crew and their tool calls, and a single waiting-on-me order that puts questions first and the longest wait first, with the wait shown.

ccdeck is AGPL-3.0. **Do not copy, vendor, translate, or wrap any of its source, hooks, log parsers, canvas, or desktop app.** Write both features fresh from Hivra's records. Credit it in SOURCES.md as ideas only. It does not go in credits.json as a copied component.

## Read first

- Hivra: `src/features/crew/ui/CrewTab.tsx`, `CrewPanel.tsx`, `src/features/crew/model/rows.ts`, `src/features/crew/model/inbox.ts` and `FirstMateInbox.tsx`, `src/features/hub/model/waitingChats.ts` (and the UI that lists it; search `WaitingOnYou` if the file has moved), `src/features/sessions/ui/AgentTranscript.tsx`, `transcriptActivity.ts`, first-mate status records. Confirm current Inbox and waiting-list order before changing them.
- ccdeck: the public README only, at https://github.com/BarganConstantin/ccdeck, as a description of the two ideas. Do not clone the repo into the worktree or open its source for translation.

## Build

A. **Live first-mate and crew tree** (tests first).

1. For a project's coding-team (first mate) chat, show a tree: first mate at the root, one child per crew worker already on the task, and, if the session records already include subagents (for example Devin's, or a Claude subagent Hivra already stores), those as children of the agent that spawned them. Do not invent a new telemetry hook to discover agents Hivra does not already know about.
2. While a node is working, its latest tool call (from the existing transcript or crew status) is visible on the node. Opening a node shows a side panel or a plain detail: the brief or last prompt, the tool calls with timing, and a link to open the chat. Reuse existing event data; do not parse Claude or Codex log files on disk.
3. Keep the existing crew tab. The tree can live next to it (a view switch, or the tree above the rows) so the row actions (open, message, stop, retry, land) stay one click away. Do not turn this into a free-roam canvas, a second product, or a colour-heavy dashboard.
4. Tests: a first mate with two workers renders the root and two children; a recorded subagent nests under its parent; a running tool call appears on the node; a missing or empty crew is an empty or first-mate-only tree, not a crash. Browser spec on Chromium and WebKit for the tree and the inspect panel.

B. **Waiting-on-me Inbox order** (tests first).

1. The first-mate Inbox (and, if it is a small hook, the "Waiting on you" list that already holds questions) uses one order: questions and other asks that need a word from the person first; then credential or permission blocks; then failures and reviews. Within each group, longest wait first (the time since the item started waiting, which may already be `askedAt` or `updatedAt`; if a wait start is missing, use the timestamp you have and say so in PR.md). Show the wait in plain words ("waiting 12 minutes").
2. Do not change how the GitHub/GitLab/Jira PR and issue Inbox is sorted, unless a first-mate row already sits in that same list; in that case only the first-mate rows follow this order, or lift them into the first-mate list rather than reshuffle someone's PR queue. Read `inbox.ts` first.
3. A click still opens the chat or the worker. The oldest waiting question should be easy to reach (it is already at the top of the questions group).
4. Tests for the sort (two questions of different ages, a question older than a failure, a credential between them). Browser spec: the first row is the oldest question.

## Copy with credit

- Add a SOURCES.md row: [ccdeck](https://github.com/BarganConstantin/ccdeck), AGPL-3.0, ideas only: the live session tree (main agent at the root, subagents as nodes, inspectable tool calls) and a waiting-on-you list ordered questions first and longest wait first. No code.
- Do not add a credits.json component and do not add NOTICE for ccdeck (no code was taken).
- Do not use the name ccdeck in the UI.

## Done when

- [ ] The tree shows first mate, crew, and recorded subagents from Hivra's own records, and a node can be inspected, with tests and a browser spec on Chromium and WebKit.
- [ ] First-mate Inbox rows are questions first, longest wait first, with the wait visible, and the GitHub PR inbox is not blindly re-sorted.
- [ ] SOURCES.md has the ideas-only row; no ccdeck source is in the tree (`git grep -i ccdeck` only hits docs/SOURCES or this WP).
- [ ] No em dashes or en dashes in any text a person sees.
