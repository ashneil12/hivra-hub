# Sources: what Hivra takes from where

Every package that takes an idea or code from another project names it here and credits it in its PR. The full
studies (read-only, Nov 2026) are in the project's research folder; the verdicts below are their conclusions.

## Licence rules

- **Port the idea** (write our own code from the design): allowed for any source below, including AGPL and
  unlicensed ones. Don't copy their text or code while doing it.
- **Vendor** (copy code, prompts or docs): only from MIT or Apache-2.0 sources, and MPL-2.0 file by file. Keep the
  licence header, add the source to the root `NOTICE`, and say what changed.
- Copy code first (Ash, 4 Nov 2026). Where the source's licence allows (MIT, Apache-2.0, MPL-2.0 file by file) and the language fits (TypeScript or Rust), vendor its code with its licence header, a NOTICE entry and a credits.json line, rather than rewriting. Where the language doesn't fit, translate the original line by line, keeping its edge-case handling, and port its tests too. Never vendor AGPL or unlicensed sources. Any rewrite needs a one-line reason in the PR. Take every useful idea a source offers, not just one.
- **Never vendor** from Rerun (AGPL-3.0 with a CLA), ROMA or OptMem (no licence file), or OpenMausBot's
  `enterprise/` folder (source-available, not open).
- **Names are not licensed.** Don't use DeepSeek Harness, OpenMausBot, MausBot, Crest, Rerun or other product names
  or logos as Hivra features. Describing compatibility ("reads DeepSeek Harness plugin indexes") is fine.
- PandaCode's MIT has an extra clause: a public fork must say so. We take ideas only, so it doesn't apply unless
  code is copied; if it ever is, the notice goes in the README and the About screen.
- The Hub's `monoTree` is a port of UniiChat's `Memory.ts` (Apache-2.0, credited in
  `src/features/monos/model/monoTree.NOTICE.md`). Before the repo is promoted widely, check its parity test does
  not echo OptMem text.

## The sources

Adding a source or vendoring a component? Add it to [credits.json](credits.json) as well, and its README line or
`NOTICE` entry: the README, `NOTICE` and the app's Credits list (Settings, About) are drawn from it, and
`src/features/settings/model/credits.test.ts` fails if they drift from this table.

| Source | Licence | What Hivra takes | How | Packages |
| --- | --- | --- | --- | --- |
| [MonoCode](https://github.com/hardbeat920/monocode) | MIT | The app: projects, sessions on many CLIs, worktrees, Monos, Inbox, remote host, Focused layout | Fork, merge upstream | all |
| [firstmate](https://github.com/kunchenguid/firstmate) | MIT | First mate role rules, brief scaffold with enforced isolation and definition of done, status protocol, zero-token watcher, durable wake queue, delivery modes and merge authority, escalation rules, crew dispatch rules, "a restart is a non-event" | Port to TypeScript and Rust (no bash); vendor contract text with credit | 10, 11, 12, 13, 14 |
| [pstack](https://github.com/cursor/plugins/tree/main/pstack) (Lauren Tan) | MIT | 58 skills for rigor and verification, `create-verification-skill` | Ship as the default plugin, unchanged | 41, 40, 42 |
| [DeepSeek super-agent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | MIT | The router never executes, workers subscribe to threads, cheap code filters before the model, a watchdog | Port the design | 10, 11 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | MIT (name is a trademark) | Plugin manager safety (pinned installs, compat check, script approval, atomic restore), reversible contributions with disposers, static plugin index and generator, Discover tab, Creator mode | Port the ideas; read its index format; vendor the index validator if useful | 30, 31, 32, 34 |
| [Agent Plugins standard](https://agent-plugins.org/) | open standard | `plugin.json`, `skills/`, `mcp.json`, reverse-domain extension folders | Adopt as Hivra's plugin format | 30 |
| [council-of-high-intelligence](https://github.com/0xnyk/council-of-high-intelligence) | MIT | Council protocol: blind round, anonymised cross-exam, anti-conformity prompt, dissent quota, stance tally, chairman template, persona file format | Rebuild the protocol in code; vendor personas and prompt text with credit | 23 |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | Apache-2.0 core (`enterprise/` excluded) | Rooms with responder modes (lead, mentions, everyone, auto with a fast decider that fails open), goal mode with a bounded coordinator loop, teams and playbooks as one Markdown file, bots as contacts, approval cards | Port the ideas | 22, 21, 15 |
| [OpenBot](https://github.com/CopilotKit/openbot) | MIT | Approval gate semantics, initiator-stamped audit, typed handoff envelope with caps, routine safety rules, quiet digest, fail-soft account check, loopback cloud sign-in | Port the ideas | 14, 15, 61 |
| [Rerun](https://github.com/rerun-build/rerun) | AGPL-3.0 + CLA | Pairing a remote engine without sending the key, memory curator with skill proposals, approval and secret cards, templates with an INSTALL.md | Ideas only, never code | 51, 61 |
| [Puppetmaster](https://github.com/professorpalmer/Puppetmaster) | MIT | Non-bypassable completion gates, typed artifacts with evidence, failure classification and reroute, leases and idempotent launches | Port | 13, 40, 60 |
| [Raven](https://github.com/EverMind-AI/Raven) | Apache-2.0 | Verdict gate ("finished" is not "succeeded"), registry-derived status, stall notice as information, Claude Code transcript importer, provenance-required memory | Port | 11, 40, 50, 51 |
| [PandaCode](https://github.com/aicodeking/pandacode) | MIT + fork-notice clause | Native protocol per CLI, warm next-turn process, steering with hold-and-replay, silence watchdog, resource policy, safe worktree UX | Ideas only | 11, 14, 15 |
| [ROMA](https://github.com/sentient-agi/ROMA) | no licence file | Atomizer fast path, planner rules (independent tasks + one synthesis, completion conditions), depth cap | Ideas only | 10, 13 |
| [AgentOS](https://github.com/akua-dev/agentos) | MIT | Assignment as the unit of accountability, decision gate with stable keys, native-session custody | Port | 10, 14 |
| [UniiChat](https://github.com/VictorTaelin/uniichat) | Apache-2.0 | Long-chat summary tree (already ported as `monoTree`) | Keep, widen | 51 |
| [OptMem](https://github.com/VictorTaelin/OptMem) | no licence | Distilled fact layer lessons | Ideas only | 51 |
| [Mercury](https://github.com/cosmicstack-labs/mercury-agent) | MIT | Soul files that upgrades never overwrite, owner-approval protocol, evidence-based beliefs | Port | 21, 51 |
| [Agent Zero](https://github.com/agent0ai/agent-zero) | MIT | Memory screen with curation, chat importer (Hermes, Claude Code), computer panel with take-over | Port | 50, 51, 61 |
| [Buzz](https://github.com/block/buzz) | Apache-2.0 | `.persona.md` format, "you are one of several sessions" room framing | Port | 22, 23 |
| [e2e](https://github.com/tester-army/e2e) | Apache-2.0 | e2e as a Verify plugin, `create-verification-skill` pattern | Optional plugin | 42 |
| [agent-desktop](https://github.com/vercel-labs/agent-desktop) | Apache-2.0 | Desktop control for workers, headless-first safety model | Optional plugin | 44 |
| [Crest](https://github.com/pauljoda/Crest) | MPL-2.0 (name not licensed) | Per-agent browser profiles, driving indicator and Stop, browsing safety defaults | Ideas; engine is Playwright or Chrome DevTools MCP | 43 |
| [CARL and PAUL](https://github.com/ChristopherKahler) | MIT | Rule staging behind approval; a four-state worker status | Ideas | 10 |
| [Orbit](https://github.com/coollabsio/orbit) | Apache-2.0 | Tasks with per-project workflows and sub-tasks, board, list and timeline views with saved views, block-editor docs with versions, home, a ⌘K palette, verified backups with one-item restore, 30-day trash, GitHub label sync, audit log, an MCP endpoint with its own OAuth, team workspaces and live co-editing | Vendor its TypeScript logic and editor with credit; translate its Rust to rusqlite; restyle its components | 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80 |
| [no-mistakes](https://github.com/kunchenguid/no-mistakes) | MIT | The gate between a branch and the PR: review, test, docs and lint in a throwaway worktree, safe fixes applied, judgment calls parked for the person, CI repair, never losing work | Pinned binary at release tag v1.111.0, driven through `axi`; not ported (Go) | 81 |
| [treehouse](https://github.com/kunchenguid/treehouse) | MIT | A pool of reusable worktrees with leases, verified return, lingering-process cleanup, quarantine of unknown ownership, `.worktreeinclude` seeding | Pinned tool driven through `get --lease --json`; not ported (Go) | 82 |
| [backpass](https://github.com/kunchenguid/backpass) | MIT | Instruction files as weights and transcripts as signal: verbatim quotes, the two-session rule, a ledger across runs, rejection memory, staging-copy diffs, a token budget, seven transcript adapters | Vendor its JavaScript as TypeScript with credit; translate missing adapters to Rust | 83 |
| [kun](https://github.com/kunchenguid/kun) | no licence | A person's OPINIONS.md and VOICE.md refreshed from what they said, read by agents; thin skills that load detail on demand | Ideas only | 83 |
| [Kun Chen's dotfiles](https://github.com/kunchenguid/dotfiles) | MIT-0 | One AGENTS.md shared by every agent CLI | Ideas | 83 |
| [HumanLayer](https://github.com/humanlayer/humanlayer) | Apache-2.0 | Research, Plan, Implement phases with short documents reviewed before code, and its 22 skills; a Claude Code plugin that mirrors terminal sessions live with reply, stop and permission answers; commit attribution by session trailer and line-hash overlap; a full local stack per worktree; tasks that group sessions and their documents. Its cloud sync (Postgres and Electric) is a reference for 61 and 80 | Copy with credit; swap its cloud transport for Hivra's local control port | 84, 85, 86, 87 |
| [Matt Pocock's skills](https://github.com/mattpocock/skills) | MIT | Small skills a first mate calls by name: a diagnosis loop for hard bugs, test-first building, and an interview that sharpens a plan with the person | Copy three with credit, called by name only | 84 |
| [portless](https://github.com/vercel-labs/portless) | Apache-2.0 | A stable name per worktree for its app and services, a local proxy that routes by name, a route registry that only its owner can remove, port allocation. The 0.17 parallel loopback dial and Windows route-lock retry are included | Translate its registry, labels and proxy to Rust with credit; no TLS, no hosts file, no sudo | 82, 87, 90, 139 |
| [emulate](https://github.com/vercel-labs/emulate) | Apache-2.0 | 14 stateful stand-ins for outside services (OAuth flows, signed webhooks, seeds, reset, snapshots), per-service base URLs | Run its pinned npm package and write its base URLs into each stack; translate its base-URL rules and file store | 82, 87, 90 |
| [oh-my-hermes](https://github.com/rlaope/oh-my-hermes) | MIT | The dag-ulw goal graph (finish line first, write scopes, layers, repair cycles, a verify node, a run verdict), per-lane model chains, reasoned memory admission, two-axis evidence labels, a deterministic skill router and LSP tools | Translate `dag_core.py` and `dag_run.py` to Rust with their tests at commit `2676c33`; the other ideas are candidates | 91 (the rest are candidates) |
| [T3 Code](https://github.com/pingdotgg/t3code) | MIT | Delegations that survive restarts, workers asking their lead, queue or steer, honest Claude results, limit resume guards, PR watch rules, worktree cleanup, restart-safe resume, recorded Claude transcripts for the fake-Claude test bench, a side question that borrows the open chat (idea only, not its code), and an optional chat list that can settle, snooze and re-sort (ideas only, no code copied) | Port the design; translate small pure files and keep the 18 recorded transcripts, each with its notice | 10, 11, 14, 40, 81, 82, 83, 112, 113 |
| [Aether](https://runaether.dev) | closed source | A machine per task, the person's own subscription, watching and steering from the phone, work that continues with the laptop closed, a reviewer that runs the changed code | Ideas only; no code and no credit | none yet |
| [Row-Bot](https://github.com/siddsachar/row-bot) | Apache-2.0 | The automatic recall policy: skip gates for greetings, runtime questions and file-only turns, a query builder, a weighted score (match, recency, tier, evidence), rejection reasons, a broad-query margin, a cap on lines and a trace of why each memory was picked or skipped; a conservative correction rule over the opening words of the person's next message; and a scan of text that looks like instructions aimed at the model | Translate `memory_policy.py` to TypeScript with its tests; semantic and graph terms folded into lexical matching. Translate `learning/corrections.py` line for line with its cases, behind the rules tier. Translate `external_content.py`'s injection scan with its cases; the fence and the warning sentence are not used | 99, 103, 111 |
| [Mnemos](https://github.com/Riley-Coyote/mnemos-mcp) | Apache-2.0 | The cue rules: four content words before a turn recalls anything, two shared words that are not common in the store, at most three lines, and never the same memory twice in a conversation; and memory that fades over the days it was used, with a lived-day clock, and one question to the person before a fact goes stale | Recall rules: ideas only. Fade: translate `mnemos/consolidation/lived.py` to TypeScript with its tests; the curve, the clocks and the ask are Hivra's | 99, 100 |
| [ccdeck](https://github.com/BarganConstantin/ccdeck) | AGPL-3.0 | Ideas only: a live session tree (main agent at the root, subagents as nodes, inspectable tool calls) and a waiting-on-you list ordered questions first and longest wait first. No code | Ideas only, never code | 119 |
| [mcode-stack](https://github.com/MiniMax-AI/mcode-stack) | MIT | Team skills a first mate calls by name: whether work should go to a subagent, a review that sees only the diff, the requirement and the test results, and turning a repeated correction into a check | Copy with credit, called by name only | 117 |
| [Memorilla](https://github.com/snap-stanford/memorilla) | Apache-2.0; its PersonalizationV4 data is CC BY 4.0 | An external test set for chat-derived memory, the arm ladder its evaluation reports, and rules for writing a memory question that cannot be guessed | Ideas and data only. The test file is fetched on demand and never copied into the repo. No Memorilla code is copied | 106 |

## Vision to packages

Every item of Ash's vision maps to packages, so nothing is dropped.

| Vision | Packages |
| --- | --- |
| One first mate that delegates to the right agents and ships | 10, 11, 12, 13, 14, 15, 20 |
| Every agent you talk to is a first mate with a crew; coding team is the general one, Monos are specialised | 20, 21, 05 |
| A council of minds | 23 |
| Groups and agent teams that talk | 22, 21 |
| Deep customisation: plugins, dashboards, tools, the app editing itself safely | 30, 31, 32, 33, 34 |
| Built-in testing and verification | 40, 41, 42 |
| Browser and desktop control | 43, 44 |
| Memory learned from chat history | 50, 51 |
| Always on (Hivra Cloud) | 60, 61 |
| Opinionated, minimal, not robotic, UI that flows | 03, 04, 05, 06, 15 |
| Mergeable with upstream, Windows working | 01, 02, 09, PLAN.md upstream rules |
| Named Hivra, sources credited | 07, 08 |
| Tasks the person and agents share, boards, docs, a home and one search box (Orbit, 4 Nov) | 70, 71, 72, 73, 74 |
| Safety nets: checked backups, trash, an activity log | 75, 76, 78 |
| GitHub issues as briefs, outside AI tools, team workspaces | 77, 79, 80 |
| Crews' work checked before GitHub, ready worktrees (Kun Chen's tools, 4 Nov) | 81, 82 |
| Agents learn from past chats with evidence; the person's opinions and voice | 83 |
| Research and plan before building, terminal sessions in Hivra, who made each commit, a stack per worktree (HumanLayer, 4 Nov) | 84, 85, 86, 87 |
| Each worktree has its own web address, and its tests meet fake outside services (portless, emulate, 5 Nov) | 82, 87, 90 |
| Skills a first mate calls by name: split only for a measured reason, review a diff from a clean context, and turn a repeated correction into a check (mcode-stack, 9 Nov) | 117 |
