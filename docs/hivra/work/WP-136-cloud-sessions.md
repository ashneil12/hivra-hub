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

### What Hivra already runs

Hivra already starts these three on this machine, as child processes, in the chat's own folder:

- Cursor speaks ACP (`src/integrations/harness/providers/cursor/cursor.ts`).
- Codex speaks its app protocol (`src/integrations/harness/providers/codex/codex.ts`).
- Claude Code is the local CLI (`src/integrations/harness/providers/claude/claude.ts`).

A cloud job is not one of those processes pointed at an undocumented switch. WP-61 is a machine the person owns. It is not a vendor cloud agent.

### Cursor

T3's user doc at the pinned commit says Cursor V2 runs through the official `@cursor/sdk` package, documented at https://cursor.com/docs/api/sdk/typescript. That doc requires a paid Cursor plan, and either a browser sign-in or a Cursor API key. It says the adapter uses the SDK's local runtime, in the workspace on the machine. It also says Cursor cloud agents need a repository and a cloud environment, and that T3 does not expose that configuration yet.

So the public integration T3 ships, at that commit, is local. Cloud agents are a Cursor product T3 names and does not drive. The Agents window docs (https://cursor.com/docs/agent/agents-window) are the public page for that product. This package does not copy T3's adapter, and it does not invent method names, REST paths, or CLI flags that were not read from Cursor's own page.

A later package may start a cloud job, read its status, pull a result, and hand it back only when Cursor's own public page, read on that day, documents each of the four. The result Hivra will accept is a branch name or a pull request URL on a repository the person already connected. Hivra then fetches that branch with ordinary git. If the public page does not document one of the four, that step is missing and the Cursor slice stops. No private endpoint, and no reading the Cursor app to guess one.

There is no cloud flag on Hivra's existing Cursor child in the sources read here. That child stays the local agent.

### Codex

No public API for a third-party app to start an OpenAI Codex cloud task.

What is public, and what Hivra already uses, is the local Codex CLI and its app protocol, with the person's ChatGPT or Codex login on this machine. T3's Codex user doc at the same commit describes that login. It does not describe a cloud-task API, a status stream, a result pull, or a handback to a local worktree.

The Codex website, the Codex desktop app, and a GitHub mention are product surfaces. They are not an API this design may call. Stop. No Codex cloud slice. A local Codex chat stays as it is. If OpenAI later publishes a cloud-task API, a new package reads that page first. This one does not keep a private path open.

### Claude

No public API for a third-party app to start a Claude cloud session.

"Dispatch" is not a name in T3's Claude provider doc, and it is not an API this design calls. Hivra already runs Claude Code locally with the person's login. That local run is not a cloud job. A local Agent SDK run is the same kind of thing: it does not keep going on Anthropic's machines after this computer is gone.

Claude Desktop may offer a cloud or remote session in its own window. Without a public API or CLI that a third party is allowed to call, Hivra does not drive it. Stop.

### Out of scope, named so they stay out

Orca's remote machine per worktree, and Paseo's encrypted relay, are not vendor cloud sessions. They belong with WP-133 and WP-61, not here.

Discussion 18019 (on-demand sandboxes) is not this package either. Renting a machine and copying a local Claude, Codex or Cursor login onto it is refused. That copies secrets off the machine, and it is not a public vendor API.

2. A UX sketch: a cloud job looks like a chat with a "running elsewhere" badge, not a second inbox. Handoff back to a local worktree if the vendor supports it.
3. Legal and billing: list what would need Ash and counsel (stored tokens, spend caps, data leaving the machine). Do not add credentials.
4. No implementation.

## Done when

- [x] Each vendor has a public-capability note or a written "no public API".
- [ ] Ash's legal and billing questions are listed.
- [ ] No product code and no new secrets.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. No T3 source file is copied. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
