# WP-136: Cloud agent sessions from Hivra: design only

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | L | WP-61 and WP-133 for Hivra's own machines. This package is vendor cloud agents, not that host | no |

This package is design only. No product code except this doc and the source notes. Ash allowed a builder to write the design on 10 Nov 2026. That does not turn a cloud job on, and it does not approve a billed account.

## Goal

A design for starting, watching and handing off Cursor cloud agents, Codex cloud tasks, and Claude cloud sessions from Hivra, so the person does not keep a second app open for work that runs somewhere else. No implementation, no new billed account, and no new stored vendor token.

## Why

This is T3's most +1 open issue, [cloud sessions #15644](https://github.com/pingdotgg/t3code/issues/15644) (40 +1, still open on 9 Nov 2026), plus [on-demand sandboxes #18019](https://github.com/pingdotgg/t3code/discussions/18019) (21 +1, open on that date). Cursor's Agents window, Codex cloud tasks, and Claude Desktop sessions are the features people keep those apps around for. Those counts are from the public issue and discussion as read on 9 Nov 2026.

## Read first

- Public docs only: [Cursor Agents window](https://cursor.com/docs/agent/agents-window), [Cursor's SDK](https://cursor.com/docs/api/sdk/typescript), and the Claude and Codex public cloud-agent docs as they stand when a later package is allowed to read them. T3 [#15644](https://github.com/pingdotgg/t3code/issues/15644).
- T3's own user docs at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`: how it runs Cursor, Codex and Claude on the machine. Ideas only. Do not copy T3 source.
- Hivra: the existing local Cursor, Codex and Claude CLI sessions, and WP-61. Do not scrape private APIs.

## Design

1. For each of Cursor, Codex and Claude, write what a public, supported API or CLI already allows: start a cloud job, stream status, pull a result, hand back to local. If the answer is "no public API", say so and stop that vendor's slice.
2. A UX sketch: a cloud job looks like a chat with a "running elsewhere" badge, not a second inbox. Handoff back to a local worktree if the vendor supports it.
3. Legal and billing: list what would need Ash and counsel (stored tokens, spend caps, data leaving the machine). Do not add credentials.
4. No implementation.

## Done when

- [ ] Each vendor has a public-capability note or a written "no public API".
- [ ] Ash's legal and billing questions are listed.
- [ ] No product code and no new secrets.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. No T3 source file is copied. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
