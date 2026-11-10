# Frank repos review (10 Nov 2026)

One row per repo from Frank's thread: the ranked list (first ten), the second pass, and Agentlas. Verdicts are
the study's conclusions, written into the docs on the `wp/frank-sources-docs` branch. Nothing here changes product
code, PLAN.md or any build queue. Every new work package is a placeholder (`WP-XX`) for Ash to number and place.

| Repo | Verdict | Where it lands, or why it is covered | Licence |
| --- | --- | --- | --- |
| Reason Network (ranked 1) | Addendum | WP-14: a chat answer counts only if it is the person's own words. Other rules already in WP-10, WP-15, WP-22, WP-91, WP-119, WP-144 | MIT OR Apache-2.0 |
| Orchestrator.inc (ranked 2) | New WP | `WP-XX-idle-chat-hibernation.md`. Derived status is already covered (session.ts read-time checks, pr_watch evaluate), and WP-11, WP-40, WP-81, WP-146 cover the rest | Apache-2.0 |
| Paseo (ranked 3) | New WP | `WP-XX-closed-agents-idle-reclaim.md` (wave D). Restart resume is covered by inFlight.ts and WP-11. Overlaps the idle-chat hibernation WP; merge one into the other | Apache-2.0 |
| Happy (ranked 4) | New WP | `WP-XX-permission-mode-matrix.md`. Per-CLI mapping exists; the gap is one matrix and one refused-change rule | MIT |
| Paradev (ranked 5) | Addendum | WP-123: a native fork that does not read a transcript. Recap handoff, fork and the omitted-context marker are already in place. Trust rules for a reported transcript path and the widening tail read are suggested for WP-85 and WP-50 and not drafted | MIT |
| Cloudroom (ranked 6) | New WP | `WP-XX-teleport-chat-between-machines.md` (wave D). Waits for WP-133 (named by WP-61 and WP-149, not in the tree) to decide the transport | Apache-2.0 |
| Emdash (ranked 7) | Addendum | WP-60: the host's inventory is authoritative, and a remote deletion intent survives an offline host. Local deletion intent is already durable (worktree_removals) | Apache-2.0 |
| Jean (ranked 8) | Addendum | WP-77: a plan waits for approval before a GitHub issue is built. Local and remote sidebar is covered. Web Access (needs WP-133) and grouping the rail by machine are not drafted | Apache-2.0 |
| Paperclip (ranked 9) | New WP and addendum | `WP-XX-spend-limits.md` (no wave chosen). Addendum to WP-91 for goal ancestry on briefs. Heartbeats and atomic checkout are covered by WP-11 and WP-70. Overlaps the Omnigent spend ceiling addendum on WP-13 | MIT (LICENSE: Copyright (c) 2025 Paperclip AI) |
| bb (ranked 10) | Sources line | SOURCES only. The CLI is not second-class on the agent side (control port, app actions). Whether the person's own terminal can use app actions was not proven | MIT |
| HarnessRouter | Addendum | WP-60: typed errors on the host and app protocols, with a retry rule per code | Apache-2.0 |
| Omnigent | Addendum | WP-13: a spend ceiling with a soft ask and a hard stop for billed models. Overlaps the spend limit WP-XX | Apache-2.0 |
| Ghostex | Sources line | Automatic account switch is already built (accountWaterfall, E5). Only the card copy is an idea | MIT |
| Nimbalyst | Addendum | WP-72: an agent's docs edit can wait as a proposal, off by default | MIT |
| Traycer | Sources line | Covered by WP-121 (model switch in one chat) and WP-120 (capability table). No debate mode | MIT |
| Sidecar | Addendum | WP-137: an agent can post a file or diff card beside its chat | MIT |
| CC Switch | Sources line | Account failover and limit marks are built (WP-13). A cross-provider circuit breaker waits for evidence of repeat failures | MIT |
| OpenCodex | Sources line | A local API gateway would be a second control plane. Revisit under WP-134 only if a needed provider needs it | MIT |
| TanStack AI | Sources line | The approval-pause idea matches WP-146. No new WP | MIT |
| OpenClaw | Sources line | Competitive reference for any future chat channel (WP-61, WP-149). Do not vendor | MIT |
| activeloopai/hivemind | Sources line | Traces to SKILL.md is WP-83. The product is cloud-backed, so no vendoring | Apache-2.0 |
| dip497/hivemind | Skip | Not in SOURCES. It may be the logo on the Agent Workspaces item. Ash to confirm which Hivemind the logo is | MIT |
| AgenticBench | Addendum | WP-92: planted-secret acceptance tests. The site is a leaderboard with no repo, and its rows carry dates after this study, so its data is unverified | No licence file |
| Agentlas (announced 10 Nov 2026) | New WP | `WP-XX-agent-os-sandbox.md` (design first, unplaced). Public desktop and OS repos are Apache-2.0. The 2.0 release itself was not confirmed as the code in those repos | Apache-2.0 |

## Left for Ash to decide

- **Two idle-reclaim packages.** `WP-XX-idle-chat-hibernation.md` (Orchestrator.inc) and
  `WP-XX-closed-agents-idle-reclaim.md` (Paseo) cover the same idea. Pick one home.
- **Two spend packages.** The Omnigent addendum on WP-13 and `WP-XX-spend-limits.md` (Paperclip) both add a money
  ceiling. Pick one home.
- **Skill approval rule.** WP-51 says a skill becomes a skill only when the person accepts it. `skillLearn.ts`
  applies a lesson at once with Undo (Ash's 14 Oct decision in the file header). The two conflict.
- **Agentlas addenda not drafted.** One-home move (WP-60 or WP-61), a scope field on memory items (WP-51), idle
  sleep (WP-161), pinned workspace tabs and the four-pane cap (WP-137), phone sensors and starting a team from the
  phone (WP-149).
- **Wave letters.** Paperclip and Agentlas both proposed a new wave L. Neither has one now.
- **WP-133** is referenced by several packages but has no file in this tree.
- **Hivemind logo.** Confirm which Hivemind the snapshot logo is before any credit line is changed.
- **Records added to credits.json.** Ideas-only sources get a SOURCES row, a credits.json entry and a README
  line, and no NOTICE entry (nothing is vendored). Agentlas and AgenticBench have no copyright line to record.
