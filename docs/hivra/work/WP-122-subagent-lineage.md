# WP-122: Native subagents and their approvals show on the parent thread

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none (crew tab already exists; do not replace it) | yes |


## Goal

When Claude, Codex or another CLI starts its own subagents, those children show on the parent thread with model, status and a short result. Approvals a child raises can be answered on the parent, as T3 shipped in [v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7). This sits next to the existing first-mate crew tab; it does not replace it. WP-119 (crew tree and waiting-on-me Inbox, `docs/hivra/work/WP-119-crew-tree-inbox.md`) already covers a live first-mate/crew tree including recorded subagents. Do not rebuild that tree. This package adds native Claude and Codex child events and child approvals on the parent thread, and should hook into WP-119's tree if that package has landed.

## Why

T3's V2 lineage view is one of the feel items people mention ([v0.1.0](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0); historic 37 +1 on nested-subagent issues). Hivra already shows first-mate workers. Native CLI subagents are still invisible, so a lead that delegates through the CLI looks broken next to T3.

## Read first

- Hivra: crew tab and first-mate worker list, approval UI (`src/features/sessions` approval components), Claude and Codex event streams.
- Already drafted and landed: WP-119 crew tree (`docs/hivra/work/WP-119-crew-tree-inbox.md`). Reuse it if present; do not fork a second tree UI.
- T3 behaviour (ideas only): [v0.1.0](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0) 'Subagents you can follow'; [v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7) 'Child approvals'.

## Build

1. Parse and store child-agent events from the CLIs that already emit them (start with Claude and Codex; others can be 'not reported by this CLI'). Tests on fixture transcripts.
2. A lineage list on the parent thread: each child has a name or role, model, status, and a result or error. Clicking opens the child's transcript if Hivra already stored it. This is a distinct list from the first-mate crew. Tests for the model; browser spec for the list.
   Review outcome: the list has no link. A native Claude child's frames carry the parent's own session id and a Codex child is a thread inside the same server, so neither is ever a transcript Hivra stored; a link could only open the parent again. The child's own steps are already in its row in the transcript. The list is read off those agent rows (`lineageForThread`), not folded from raw frames a second time.
   Layout outcome: the list is drawn inside the transcript's own scroll content (a `lineage` prop on `AgentTranscript`), never as a sibling above it, because the transcript's scroller is `h-full` and a sibling pushes the newest messages under the composer. It opens as one line, the tally of what the children are doing, and the rows open on request in a box capped at 14rem that scrolls inside. The transcript keeps its per-turn subagent row, the only place a child's steps open, so the list does not repeat it as rows until asked. `tests/browser/wp122-layout.spec.ts` mounts the real pane at 1000 by 700 with 3, 6 and 12 children and checks the newest message sits above the composer.
3. When a child raises an approval, it appears on the parent with enough context to answer, and the answer is forwarded to the child. Tests that approve and deny each reach the child session port.
   A Claude ask that arrives before its child's frame, or names no call, while a delegated run is open is shown as "a subagent" (Claude announces the parent's own calls before it asks about them, so an unannounced one is a subagent's). It is answered on its own request id like any other.

## Done when

- [ ] Fixture transcripts for Claude and Codex produce a lineage list.
- [ ] A CLI that does not report children is labelled, not faked.
- [ ] A child approval can be answered on the parent.
- [ ] The first-mate crew tab is unchanged in role.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
