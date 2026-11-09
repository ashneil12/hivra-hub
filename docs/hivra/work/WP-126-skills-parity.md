# WP-126: Skills, MCP and project rules, visible per CLI

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none | yes |


## Goal

For a project, the person can see which skills, MCP servers and project rules each CLI will actually load, and which of those do not travel when they switch CLI mid-thread or mid-crew. Where Hivra can share a skill or rule, it does. Where it cannot, the UI says so before the person is surprised.

## Why

This is a recurring T3 complaint (6 Nov survey, item B7; HN comments on skills not following a mid-thread switch). T3 has not fixed the feel. If Hivra is honest and, where possible, actually shares skills across CLIs, that is a beat, not a match.

## Read first

- Hivra: skills and pstack, MCP install, project rules / CLAUDE.md and equivalents, plugin skills, the mid-thread handoff (WP-121 if merged).
- T3: no source to copy. The gap is documented in Hivra research `love.md` (complaint B7).

## Build

1. A per-project, per-CLI report: skills found, MCP servers attached, rule files read. Built from what Hivra already knows or can read on disk (do not scrape a CLI's private cache if that would violate its terms). Tests with fixture project folders for at least Claude, Codex and one other CLI.
2. A settings or project panel that shows the report in plain words, including 'this will not be visible to Codex' (or similar) when a skill is Claude-only. Browser spec.
3. If a mid-thread switch or a first-mate handoff would drop skills the current CLI had, say so in the confirm (reuse WP-121 copy if it exists). Tests for the warning, and for the case where everything travels.
4. Where a skill file is already in a shared, documented location both CLIs read, do not duplicate it. Do not invent a new skills format in this package.

## Done when

- [ ] Fixture projects produce an accurate per-CLI report for at least three CLIs.
- [ ] The panel and the switch warning tell the person what will not travel.
- [ ] No new skills format was invented.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
