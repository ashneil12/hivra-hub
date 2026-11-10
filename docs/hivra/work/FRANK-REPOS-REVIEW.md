# Frank repos review (10 Nov 2026)

One row per repo from Frank's thread: the ranked list (first ten), the second pass, and Agentlas. Verdicts are
the study's conclusions, written into the docs on the `wp/frank-sources-docs` branch. Nothing here changes product
code, PLAN.md or any build queue. Every new work package is a placeholder (`WP-XX`) for Ash to number and place.

| Repo | Verdict | Where it lands, or why it is covered | Licence |
| --- | --- | --- | --- |
| Reason Network (ranked 1) | Addendum | WP-14: a chat answer counts only if it is the person's own words. Other rules already in WP-10, WP-15, WP-22, WP-91, WP-119, WP-144 | MIT OR Apache-2.0 |
| Orchestrator.inc (ranked 2) | New WP | `WP-XX-idle-reclaim-and-hibernation.md` (one draft shared with Paseo). Derived status is already covered (session.ts read-time checks, pr_watch evaluate), and WP-11, WP-40, WP-81, WP-146 cover the rest | Apache-2.0 |
| Paseo (ranked 3) | New WP | `WP-XX-idle-reclaim-and-hibernation.md` (wave D proposed; one draft shared with Orchestrator.inc). Restart resume is covered by inFlight.ts and WP-11 | Apache-2.0 |
| Happy (ranked 4) | New WP | `WP-XX-permission-mode-matrix.md`. Per-CLI mapping exists; the gap is one matrix and one refused-change rule | MIT |
| Paradev (ranked 5) | Addendum | WP-123: a native fork that does not read a transcript. Recap handoff, fork and the omitted-context marker are already in place. Trust rules for a reported transcript path and the widening tail read are suggested for WP-85 and WP-50 and not drafted | MIT |
| Cloudroom (ranked 6) | New WP | `WP-XX-teleport-chat-between-machines.md` (wave D). Waits for WP-133 (named by WP-61 and WP-149, not in the tree) to decide the transport | Apache-2.0 |
| Emdash (ranked 7) | Addendum | WP-60: the host's inventory is authoritative, and a remote deletion intent survives an offline host. Local deletion intent is already durable (worktree_removals) | Apache-2.0 |
| Jean (ranked 8) | Addendum | WP-77: a plan waits for approval before a GitHub issue is built. Local and remote sidebar is covered. Web Access (needs WP-133) and grouping the rail by machine are not drafted | Apache-2.0 |
| Paperclip (ranked 9) | New WP and addendum | `WP-XX-spend-limits.md` (no wave chosen). Addendum to WP-91 for goal ancestry on briefs. Heartbeats and atomic checkout are covered by WP-11 and WP-70. The one home for the money limit; it also carries Omnigent's per-task ceiling | MIT (LICENSE: Copyright (c) 2025 Paperclip AI) |
| bb (ranked 10) | Sources line | SOURCES only. The CLI is not second-class on the agent side (control port, app actions). Whether the person's own terminal can use app actions was not proven | MIT |
| HarnessRouter | Addendum | WP-60: typed errors on the host and app protocols, with a retry rule per code | Apache-2.0 |
| Omnigent | Folded into a new WP | `WP-XX-spend-limits.md`: a per-task ceiling with a soft ask and a hard stop for billed models, and no reroute onto a billed model without the person's OK. WP-13 keeps a one-line pointer | Apache-2.0 |
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

## Settled for this merge

- **Idle reclaim has one home.** `WP-XX-idle-reclaim-and-hibernation.md` credits Orchestrator.inc and Paseo. Where the two
  drafts differed, the merge reads: off by default until a live check passes (Orchestrator.inc), no new board status
  (a closed chat shows as closed in the Inbox and the tab list only), and a one-hour idle time (Paseo) checked by a
  30 second sweep (Orchestrator.inc). Ash to confirm the default when the package is placed.
- **Spend limits have one home.** `WP-XX-spend-limits.md` (Paperclip, with Omnigent's per-task ceiling). The WP-13
  addendum is now a one-line pointer. The two sources disagree about stopping a run in progress, so the draft keeps
  both at different scopes and marks it for Ash.

## Follow-ups

Recorded here, not decided.

- **(a) Skill approval.** WP-51 says a learned skill becomes a skill only when the person accepts it.
  `src/features/selfBuild/model/skillLearn.ts` applies a lesson at once, logged, with Undo (Ash's 14 Oct decision in the
  file header). The two conflict, so a product decision is needed.
- **(b) WP-133 is missing.** The teleport draft (`WP-XX-teleport-chat-between-machines.md`) waits on WP-133 for the
  transport, and WP-61, WP-132 and WP-149 name it too. No `WP-133` file exists in this tree.
- **(c) Agentlas ideas not drafted.** One home for the personal agent with an atomic move (WP-60 or WP-61), memory scoped
  per agent (a scope field on memory items, WP-51), idle agents sleep (WP-161; the idle reclaim draft already covers a chat's process), pinned workspace tabs and the four-pane
  cap (WP-137), and phone sensors and starting a team from the phone (WP-149).
- **(d) Wave L.** The Paperclip and Agentlas drafts proposed a new wave L. Neither is placed; both stay unassigned.

Also open:

- **Hivemind logo.** Confirm which Hivemind the snapshot logo is before any credit line is changed.
- **Records added to credits.json.** Ideas-only sources get a SOURCES row, a credits.json entry and a README
  line, and no NOTICE entry (nothing is vendored). Agentlas and AgenticBench have no copyright line to record.
