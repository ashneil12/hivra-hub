<h1 align="center">Hivra</h1>

<p align="center">
  <strong>An experiment in running projects with a team of agents.</strong><br />
  A fork of <a href="https://github.com/hardbeat920/monocode">MonoCode</a>.
</p>

> [!WARNING]
> **This is an experiment. Don't take it seriously.** Hivra is Ash's personal build, made in public. It
> changes all the time, it isn't supported, and it may break. If you want a working app, use
> [upstream MonoCode](https://github.com/hardbeat920/monocode).

## What this is

Hivra is a fork of [MonoCode](https://github.com/hardbeat920/monocode), a desktop GUI for coding agents
(Claude Code, Codex, Cursor, Grok Build, OpenCode, Hermes and others). It stays a MonoCode fork on purpose
and keeps merging upstream changes in.

On top of MonoCode, Hivra is a harness for **managing** agents rather than chatting with one: a lead that
takes your asks, hands work to agents across your projects, keeps track of what's done and what isn't, and
comes back to you when it needs a decision.

The idea is to **curate, not invent**. Instead of building every piece from scratch, Hivra picks proven
pieces and puts them in the right places: a few ship by default, and the rest are optional plugins. It
should stay small.

## Inspirations

Hivra takes ideas, and in a few places code, from these projects. What it takes from each, under which licence, is in
[docs/hivra/SOURCES.md](docs/hivra/SOURCES.md); vendored code is credited in [NOTICE](NOTICE). The app shows the same list
in Settings, under About.

- [MonoCode](https://github.com/hardbeat920/monocode): the app Hivra is built on (projects, sessions on many CLIs, worktrees, Monos and the Inbox).
- [firstmate](https://github.com/kunchenguid/firstmate): the first mate role, briefs with a definition of done, the status protocol and crew dispatch. The Pi watcher arm is not part of Hivra.
- [pstack](https://github.com/cursor/plugins/tree/main/pstack): Lauren Tan's (poteto) skills for rigour and verification, shipped as the default plugin.
- [DeepSeek super-agent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype): a router that never does the work itself, workers that follow threads, a watchdog.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): safe plugin installs, a static plugin index, Discover and Creator mode (ideas only).
- [Agent Plugins standard](https://agent-plugins.org/): the plugin format.
- [council-of-high-intelligence](https://github.com/0xnyk/council-of-high-intelligence): the council protocol (blind round, cross-exam, dissent quota and a chairman).
- [OpenMausBot](https://github.com/milind-soni/OpenMausBot): rooms with responder modes, goal mode, teams and playbooks as one file.
- [OpenBot](https://github.com/CopilotKit/openbot): approval gates, an audit trail, typed handoffs and quiet digests.
- [Rerun](https://github.com/rerun-build/rerun): remote engine pairing, a memory curator and approval cards (ideas only).
- [Puppetmaster](https://github.com/professorpalmer/Puppetmaster): completion gates, typed artifacts with evidence, failure reroutes, session leases and idempotent launch keys.
- [Raven](https://github.com/EverMind-AI/Raven): "finished" is not "succeeded", status from the registry, provenance-required memory.
- [PandaCode](https://github.com/aicodeking/pandacode): native protocol per CLI, warm processes, steering and a silence watchdog (ideas only).
- [ROMA](https://github.com/sentient-agi/ROMA): a fast path for small tasks and planner rules (ideas only).
- [AgentOS](https://github.com/akua-dev/agentos): assignments as the unit of accountability, decision gates and native-session custody.
- [UniiChat](https://github.com/VictorTaelin/uniichat): the long-chat summary tree behind monoTree.
- [OptMem](https://github.com/VictorTaelin/OptMem): lessons on a distilled fact layer (ideas only).
- [Mercury](https://github.com/cosmicstack-labs/mercury-agent): soul files upgrades never overwrite and owner approval.
- [Agent Zero](https://github.com/agent0ai/agent-zero): a memory screen with curation and chat importers.
- [Buzz](https://github.com/block/buzz): the persona file format and room framing.
- [e2e](https://github.com/tester-army/e2e): end-to-end testing as an optional Verify plugin.
- [agent-desktop](https://github.com/vercel-labs/agent-desktop): desktop control for workers, headless first.
- [Crest](https://github.com/pauljoda/Crest): per-agent browser profiles and browsing safety defaults (ideas only).
- [CARL and PAUL](https://github.com/ChristopherKahler): rule staging behind approval and a four-state worker status.
- [Orbit](https://github.com/coollabsio/orbit): tasks and boards, docs, a search palette (the finder, WP-74), checked backups, trash, GitHub issue sync and a safe MCP door. The home column and entrance landed in WP-73.
- [no-mistakes](https://github.com/kunchenguid/no-mistakes): the local gate that checks a crew's branch before it reaches GitHub, used as a pinned tool, planned for Wave F.
- [treehouse](https://github.com/kunchenguid/treehouse): a pool of ready worktrees that keep their installs and build cache, used as a pinned tool, planned for Wave F.
- [backpass](https://github.com/kunchenguid/backpass): evidence-gated edits to agent instructions learned from past chats, landed in WP-83.
- [kun](https://github.com/kunchenguid/kun): a person's opinions and voice kept as files agents read (ideas only).
- [Kun Chen's dotfiles](https://github.com/kunchenguid/dotfiles): one AGENTS.md shared by every agent CLI.
- [HumanLayer](https://github.com/humanlayer/humanlayer): research and plan before building. The skills were copied from apps/riptide-rpi-claude-plugin at f9bd73534a9fb7099a274f951b698b1297122fd9. Terminal sessions mirrored into the app, commit attribution and a local stack per worktree are still planned for Wave G.
- [Matt Pocock's skills](https://github.com/mattpocock/skills): diagnosing-bugs, tdd, grill-me and grilling, copied from mattpocock/skills at 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d and called by name only.
- [portless](https://github.com/vercel-labs/portless): a stable name per worktree for its app and services, a local proxy that routes by name, and a route registry only its owner can remove (WP-90). The 0.17 parallel loopback dial and Windows route-lock retry are included (WP-139).
- [emulate](https://github.com/vercel-labs/emulate): 14 stateful stand-ins for outside services, so a crew's tests use fake accounts instead of real ones (WP-90).
- [oh-my-hermes](https://github.com/rlaope/oh-my-hermes): the dag-ulw goal graph: a finish line first, write scopes, repair cycles, a verify node and a run verdict, planned for Wave J.
- [T3 Code](https://github.com/pingdotgg/t3code): the PR watch rules, honest Claude results, delegation delivery and stop rules, limit auto-resume guards, worktree cleanup cases and 18 recorded Claude transcripts for the test bench.
- [T3 Code usage](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/usage.md): always-on context remaining in an open chat, usage history filters by provider and model, and dollar figures labelled as estimates (WP-127), from docs/user/usage.md at e85e0094dd4617a1eada1ad7961f2132a79e67b2.
- [Aether](https://runaether.dev): ideas only: a machine per task, the person's own subscription, phone control and a reviewer that runs the changed code.
- [Row-Bot](https://github.com/siddsachar/row-bot): the automatic recall policy: skip gates, a query builder, a weighted score, rejection reasons, a broad-query margin, a cap on lines and a trace (WP-99), the correction rule behind the rules tier (WP-103), and a scan that refuses text which looks like instructions aimed at the model (WP-111).
- [Mnemos](https://github.com/Riley-Coyote/mnemos-mcp): ideas for the recall rules (four content words, two distinctive shared words, at most three lines, each memory once per conversation; WP-99), and memory that fades over the days it was used rather than the calendar, with a lived-day clock and one question to the person before a fact goes stale (WP-100).
- [ccdeck](https://github.com/BarganConstantin/ccdeck): ideas only: a live session tree (main agent at the root, subagents as nodes, inspectable tool calls) and a waiting-on-you list ordered questions first and longest wait first.
- [Memorilla](https://github.com/snap-stanford/memorilla): an external test set for chat-derived memory, the arm ladder its evaluation reports, and rules for writing a memory question that cannot be guessed (WP-106, ideas and data only).

Also [poteto](https://x.com/poteto)'s writing on skills and verification, including the
[verification skill example](https://github.com/poteto/verification-skill-example).

## Status

Early. Expect the code and this page to change a lot. The build plan, split into work packages for the
agents that build it, is in [docs/hivra](docs/hivra/README.md). Agents working in this repo should read
[AGENTS.md](AGENTS.md) first: every agent CLI reads that file, and [CLAUDE.md](CLAUDE.md) imports it.

## Building

Same as MonoCode: Node.js 20+ and a stable Rust toolchain. See [build setup](docs/building.md). This fork
has its own build and dev scripts (`npm run hub:dev`, `npm run hub:build`), described in
[AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE), like MonoCode. Hivra is not affiliated with MonoCode or with the makers of the agents it
drives. Provider names and logos are trademarks of their owners. See [NOTICE](NOTICE).
