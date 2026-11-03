# WP-42: e2e Verify plugin

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | S | 31 | yes |

## Goal

Projects with a web or mobile UI can turn on a Verify plugin, so workers prove UI changes by driving the app and
attaching evidence.

## Why

Ash's built-in testing for people who build things. tester-army/e2e (Apache-2.0) is the strongest option found: an
MCP server and a skill, runs on the person's own Claude Code or Codex login, no hosted service.

## Read first

- tester-army/e2e: `docs/mcp-server.mdx`, `docs/coding-agents.mdx`, `skills/create-verification-skill/SKILL.md`
  (it says a native desktop app has no engine yet, so it can't test Hivra's own window).
- WP-30 and WP-31; WP-40's gates (where its evidence lands).

## Build

1. A Verify plugin entry in the default index: e2e's MCP server (pinned npm version) and its skills, plus a Hivra
   persona-free skill that tells a worker when to use it.
2. Offered (not installed) when a project looks like it has a web or mobile UI; installing needs the person's OK.
3. Evidence files (`.e2e/`) are attached to the worker's report and linked from the Crew tab.
4. Credit e2e in `NOTICE` if any of its files are vendored (prefer installing its package unchanged).

## Done when

- [ ] Test: the entry validates and installs from the index (stubbed package); a worker session gets the MCP server.
- [ ] A dev-copy check on a sample web project: a worker proves a UI change with e2e evidence.
- [ ] `npm run check` passes.
