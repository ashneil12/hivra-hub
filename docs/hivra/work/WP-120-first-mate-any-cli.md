# WP-120: The first mate can lead a crew on any funded CLI

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none (WP-20 already shipped) | yes |


## Goal

The project's coding-team lead is no longer Claude-only. Whatever CLI the person picks for the first mate can brief workers, attach the lead tools, and run a crew, or the UI says plainly that this CLI cannot lead yet and why.

## Why

T3 Code's `delegate_task` (stable in [v0.1.0](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0)) can start a child on any provider or model. Hivra's first mate is already the stronger product (a general lead chat that never edits the project itself), but the lead tools are attached only on Claude Code (`src/features/hub/model/hubMcp.ts`). That is the hole in Hivra's best talking point. Close it and Hivra leaps T3 on the thing T3 calls Orchestrator V2.

## Read first

- Hivra: `src/features/hub/model/hubMcp.ts` (where tools are attached today), `src/features/hub/model/codingTeam.ts`, `src-tauri/src/firstmate/`, `src/features/sessions/model/session.ts` (registered CLIs), WP-20 and WP-89.
- T3 behaviour (ideas only): [v0.1.0 release notes](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0) on `delegate_task`; do not port T3's MCP server.

## Build

1. Find every branch that only attaches first-mate or coding-team tools when the engine is Claude Code. Replace that with a capability table: for each registered CLI, either the lead tools attach, or a named reason is recorded (for example 'this CLI has no MCP host'). Tests: at least Claude, Codex, Cursor, Grok, OpenCode and Pi are in the table; a CLI marked capable actually receives the tools; a CLI marked not capable does not, and the person sees the reason in the lead chat, not a silent no-op.
2. The first-mate picker and any copy that implies 'Claude is the lead' must list every capable CLI. If the person is on a CLI that cannot lead, offer a switch, and keep the existing crew and memory. Tests for the picker model; no screenshot unless you add a new control.
3. A crew started from a non-Claude lead still cannot have the lead edit the project itself (the WP-20 rule). Tests that the lead's write tools stay off for every capable CLI.
4. Browser spec on Chromium and WebKit for the picker and the 'this CLI cannot lead yet' message.

## Done when

- [ ] A test fails if lead tools are attached only by checking for Claude.
- [ ] Codex, Cursor, Grok, OpenCode and Pi are each either capable with tools attached, or show a written reason.
- [ ] The lead still never edits the project, on every capable CLI.
- [ ] Browser spec covers the picker and the cannot-lead message.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
