# Hivra: what we are building

Status: agreed with Ash on 3 Nov 2026. This spec replaces the direction parts of `docs/HUB-PLAN.md`,
`docs/PHASE-2-DESIGN.md` and `docs/leadership/`; those stay as history until the packages that retire them land.

## 1. What Hivra is

Hivra is a desktop harness for running projects with a team of agents. It is a fork of
[MonoCode](https://github.com/hardbeat920/monocode) and keeps merging upstream. You open a project and talk to its
first mate. The first mate turns what you ask into briefs, hands them to the right agents (Claude Code, Codex,
Grok, Cursor, OpenCode, Hermes or any CLI MonoCode drives), watches them, checks the work, and brings back finished
results or the decisions only you can make. It runs on your own subscriptions, locally first; Hivra Cloud later
keeps the same work running while the laptop is off.

## 2. Principles

1. **Curate, don't invent.** Take proven designs from the projects in [SOURCES.md](SOURCES.md). Write new design
   only where none of them covers the need, and say so in the package.
2. **Keep what works, improve it in place.** No rewrites from scratch.
3. **Code owns the mechanics, agents own the judgment** (firstmate's "scripts own the mechanics", DeepSeek's
   "the router never executes"). Status, limits, retries, merges, gates and timers are deterministic code. Cheap code
   filters run before any model is woken.
4. **Done means proved.** A worker saying "done" is a claim. A gate in code (tests ran, a diff exists, checks are
   green) turns it into a result.
5. **Minimal, not robotic.** A small, fixed status vocabulary, derived from records, not from model prose. Messages
   say outcomes in plain words. No hand-tuned rule layers for how a chip should look.
6. **One way to do each thing.** One layout, one agent concept (the first mate), one plugin format.
7. **Stay mergeable with upstream MonoCode.** New features live in new modules (`src/features/<feature>`,
   `src-tauri/src/<feature>`); upstream files only get small hooks.
8. **Any CLI, any platform.** Nothing in the core depends on one agent CLI or on bash. macOS first, Windows and Linux
   kept working in CI.
9. **Never risk the daily app or its data.** Everything in AGENTS.md about dev copies, ship and identity still holds.
10. **Credit every source and respect its licence** (see SOURCES.md for the rules).

## 3. The model

| Concept | What it is | Built from |
| --- | --- | --- |
| **Project** | A folder or repo you work in. | upstream MonoCode |
| **First mate** | The agent you talk to. It plans, briefs, supervises and reports; it never edits the project itself. | firstmate's contract on the Hub's delegation engine |
| **Crew** | The workers a first mate runs. Each worker is a session on any CLI, in its own worktree (or read-only for research). | MonoCode sessions + worktrees, Hub delegations |
| **Coding team** | The default first mate every project has: general, for any coding work. | today's coding team Lead |
| **Mono** | A first mate specialised by its soul, skills, memory, habits and crew. Persistent across projects. | upstream Monos + Hub Mono home |
| **Group** | A room where you and several first mates talk. Optional. | Hub rooms + OpenMausBot's room modes |
| **Council** | A group run with rules: blind first round, anonymous cross-examination, a tally that keeps the minority view, a chairman's verdict. | council-of-high-intelligence's protocol, in code |
| **Plugin** | An Agent Plugins package: skills, MCP servers, and Hivra extensions (panels, personas, Mono templates, crew rules). | Agent Plugins standard + DeepSeek Harness's install and Creator ideas |
| **Panel** | A dashboard: what the Hub calls a Page, now one kind of plugin. | Hub Pages sandbox |
| **Memory** | A Mono's soul and memory files, the long-chat tree, project notes, and (later) what Hivra learns from your chat history. | Hub Mono home, UniiChat tree, Raven/Rerun ideas |
| **Hivra Cloud** | A remote machine (upstream's remote host) where first mates and crews keep running. Later. | upstream remote host |

Nesting: a first mate's crew member is either a worker or another first mate (a Mono can brief a project's coding
team, as Monos brief Leads today). Depth is capped at 2 in code: first mate, first mate, workers.

## 4. How a first mate works

The loop, with who owns each step:

1. **Intake (model).** Read the ask. Small and clear: delegate straight away to one worker (the atomizer fast path,
   ROMA). Larger: write a short plan of independent tasks plus one synthesis step, each with a completion condition
   (ROMA's planner rules). Questions are answered directly; reading the project is allowed, editing it is not.
2. **Brief (code scaffold, model fills the intent).** Every brief is generated from one template (firstmate's
   `fm-brief.sh`): isolation check ("stop if you are in the main checkout"), the intent, the spec, the definition of
   done, the status protocol, and where steering messages arrive. The model writes only the intent and the spec;
   code refuses a brief with placeholders left.
3. **Route (code, with model override).** Which CLI, model and effort: the user's override, then the project's crew
   rules, then the defaults. A failure that is about the account (quota, auth, billing, missing CLI) moves the task
   to the next funded worker under a retry budget (Puppetmaster's reroute).
4. **Spawn (code).** A worktree, a session on the chosen CLI with the brief, a delegation record (the Hub's
   `delegations.rs` engine, the `delegate_task` MCP tool).
5. **Watch (code, zero tokens).** A watcher reads status lines, session events, PR checks and timers. It wakes the
   first mate only for events that need judgment, through a durable wake queue that survives restarts (firstmate's
   watcher and wake queue). Silence produces one notice per stretch, not repeated alarms (Raven); a worker silent
   for 20 minutes with no pending question is stopped (PandaCode); asking for approval never counts as silence.
6. **Verify (code first, then model).** Completion gates in code: a diff exists, the required commands pass, the
   work is committed (Puppetmaster's gates). Then a cheap verdict check: was the brief actually accomplished?
   ("finished" is not "succeeded", Raven). Failed gates fail the task; the worker gets one fix round, then the first
   mate decides.
7. **Deliver (code, by project setting).** Local only, a PR, or a gated PR that must be green. Merging needs the
   person's word unless the project says "yolo"; red is never merged (firstmate's delivery modes).
8. **Report (model, outcomes only).** The first mate tells the person only: decisions they must make, review-ready
   results, failures, and credential needs (firstmate's escalation rules). Each message stands alone.

Status vocabulary (the only states shown anywhere): **working**, **needs you**, **done**, **failed**, plus
**paused** for work waiting on a time or an outside event. They are computed from delegation records and gates,
never from what a model says about itself.

Decisions use stable keys: a question to the person is stored once under a key, shown in the Inbox, and answering
it releases every task waiting on it (AgentOS's decision gate).

A restart is a non-event: the records on disk are the truth, the wake queue is drained on start, and cut turns
resume (the Hub's restart-safe resume).

## 5. Coding team and Monos

- Every project has a **coding team**: a general first mate whose crew defaults to the CLIs the person has signed
  in to. It is what you use when you just want work done in a project. You never have to use Monos.
- A **Mono** is a first mate with a specialty. It has a soul (role, who it is, what it watches for, skills), a
  memory, optional habits (schedules), connectors, and crew rules that suit its specialty (a design Mono might
  prefer a model good at UI and an e2e plugin for checking).
- The Hub's Chief of Staff, Projects Manager, frank, Alfred and Critiquito become ordinary Monos made from
  templates. Nothing about them is special-cased in code.
- Monos feel like contacts in a messaging app (OpenMausBot): a list you chat with, each with its own model and
  tools, not a dashboard.

## 6. Groups and councils

- A **group** is a room with you and any first mates or Monos. Who answers a message is set per room
  (OpenMausBot's responder modes): **lead** (the room's lead answers), **mentions** (only who you @mention),
  **everyone**, or **auto** (a fast, cheap decider picks one member, or several, and falls back to the lead when
  unsure or slow). A **goal** mode lets the room's lead run a bounded number of turns toward a goal, choosing who
  speaks next, and stop on done, needs-you or blocked. The Hub's rooms (`rooms.rs`, `roomConductor.ts`) are the base;
  their turn brake stays.
- A **council** is a group preset for hard calls. Seats run on different CLIs and model families for real
  diversity. Rounds are enforced by code: restate, blind answers, anonymous cross-examination, final stance lines.
  Code counts the tally against a two-thirds line and keeps a minority report; "no consensus" is a valid outcome. A
  chairman on a different provider writes the verdict in a fixed template (unresolved questions, kill criteria,
  concrete next step, minority report). The first mate can convene one with `/council` and then delegate the next
  step. Personas are plain files (council-of-high-intelligence's format) and can come from plugins.

## 7. Plugins

- **Format: the open Agent Plugins standard** (`plugin.json`, `skills/`, `mcp.json`), which Codex, Cursor and
  others read, plus a Hivra extension folder (reverse-domain, per the standard) for what only Hivra understands:
  panels, council personas, Mono templates, crew rules, slash commands. pstack is already in this format.
- **What a plugin can add:** skills (installed where each CLI looks for them), MCP servers (added to sessions'
  config), panels (sandboxed dashboards), personas, Mono templates and crew rules. Plugins never run code inside the
  app: their code runs as MCP servers or inside the panel sandbox, with declared permissions.
- **Installs are safe and reversible** (DeepSeek Harness's plugin manager): pinned to an exact version or commit, a
  compatibility check before download, approval before any install script runs, approval for any install an agent
  starts, atomic restore when something fails, one-click rollback to the previous version. Every contribution is
  registered with a disposer, so uninstall and update leave nothing behind.
- **Discover** reads static indexes and never runs plugin code to list them: Hivra's index, DeepSeek Harness-format
  indexes, and Claude Code plugin marketplaces where the content is portable (skills, MCP servers).
- **Creator mode:** an agent preset with skills that writes a plugin for you, installs it live in a dev copy,
  and lets you keep or undo it (the Hub's self-build worktree, preview and undo pattern).
- **Panels** are the Hub's Pages: the sandboxed iframe, strict CSP and permissioned bridge stay; the Ash OS build
  call goes. A panel is built with Creator mode.
- Default plugins: **pstack** (rigor and verification skills, in every chat). Offered: **e2e** (prove UI work),
  **Browser** (an agent browser with per-agent profiles), **Desktop control** (agent-desktop, opt-in),
  **Council personas**.

## 8. Memory

- Keep: each Mono's SOUL.md and MEMORY.md (`mono_home.rs`), the long-chat summary tree (UniiChat's design,
  `monoTree.ts`), project notes.
- Later: an importer that reads your chat history (Claude Code transcripts first, then Codex and Hermes) in
  resumable batches and distils how you work into memory where every line cites its source (Raven), a curator that
  keeps one durable fact per turn or none and turns procedures into skill proposals you accept (Rerun's idea), and
  a memory screen to review, edit and delete (Agent Zero's idea). Recalled memory is placed in the turn, fenced as
  untrusted.
- Gone: the Ash OS memory bridge.

## 9. Always on (later)

Hivra Cloud is a remote machine running upstream's host (`host/`, Add machine over SSH). To keep work going with
the laptop shut, the first mate, its delegation records and its watcher run on the host, not only in the desktop's
database. Pairing never sends the key over the wire (Rerun), account checks fail soft and never block (OpenBot),
routines have safety caps (OpenBot: 15-minute floor, stop after repeated failures), and a "what ran while I was
away" feed reads from records stamped with what started each run.

## 10. The app

- **One layout.** Upstream offers Classic and Focused; Hivra has exactly one: **Classic**. WP-03 measured Focused
  switching tabs 1.5 to 1.9 times slower on upstream's own benchmark (warm p95 about 90 ms against 48 ms), so the
  default choice of Focused fell to the measurements. The setting is gone; the hook in upstream files is tiny and
  upstream's Focused code stays. Right-panel work such as the Crew tab (WP-15) goes in Classic's right sidebar
  (Ctrl+Shift+B) or its sidebar tabs, since the Focused right panel isn't rendered.
- **Where things live.** The projects rail on the left. The project's coding team chat is the home of a project.
  The right panel carries a **Crew** tab (each worker: status, branch, diff, PR and checks, open as a tab), next to
  upstream's Files, Changes and History. Monos are a contacts-style list; groups sit with them. Everything that
  needs the person goes to upstream's **Inbox**, which already holds PRs, issues and CI repairs from GitHub, GitLab,
  Jira and Linear; a first mate's decisions and review-ready results become one more item kind there. Panels open as
  tabs. Plugins live in Settings (Installed, Discover, Creator).
- **What goes from today's Hub UI:** Today, Being built and the Needs-you screens, the red/grey chip rules, the
  rNN-tuned status lines, and Ash-specific names in the UI. The Inbox and the Crew tab replace them.
- **First launch:** pick the CLIs you have, pick a project, chat with its coding team. Monos and groups are offered,
  not required.
- **Name:** the app becomes Hivra (WP-07). The data folder only moves with a migration and Ash's OK.

## 11. Keep, improve, retire

| Area | Today | Decision |
| --- | --- | --- |
| Delegation engine (`delegations.rs`, `mcp_server.rs` task tools, `worker_queue.rs`, stall detection) | works, tested | **Keep** as the first mate's engine; add the contract, watcher and gates on top |
| Restart-safe resume, fake-Claude bench (`scripts/fake-claude.mjs`, `hub:verify-live`) | works | **Keep** |
| Ship with rollback, dev copies, identity guard (`ship.rs`, `instance.rs`, `scripts/hub-*.mjs`) | works on macOS | **Keep**; other platforms later |
| Pages sandbox and bridge (`src/features/pages`, `page_http.rs`) | front half works | **Keep** as the panel plugin type; drop the Ash OS build path |
| Self-build (`self_build.rs`, `src/features/selfBuild`, `src/features/hubChange`) | partial | **Keep the pattern** for Creator mode; drop the Ash OS coupling |
| Rooms (`rooms.rs`, `roomConductor.ts`, `GroupChatView.tsx`) | partial | **Keep** as groups and councils |
| Monos, Mono home, long-chat tree | works | **Keep**; Monos become first mates |
| Autopilot, reminders | works on macOS | **Keep** |
| Connectors, model router, PR watch, portable export/import | works | **Keep** |
| Upstream orchestration, automations, Inbox, remote host, mobile | upstream | **Keep, don't touch** |
| Chief of Staff / Leads persona layer, `docs/leadership/*`, hand-tuned rNN prompt rounds | thin, Ash-specific | **Retire**: become Mono templates and the first mate contract |
| Ash OS bridge (`hub.rs`, `ash-hub-*` calls, Ash OS stubs) | external, shaky | **Retire**; what's still needed moves to local storage |
| Today, Being built, Needs you, status-chip rules (`src/features/hub/ui`) | robotic | **Retire**; Inbox and Crew tab replace them |

Retiring means removing the code and its tests together in one PR, with a git tag (`archive/<name>`) on the last
commit that still had it. Nothing is lost from history.

## 12. Not now

Forking DeepSeek Harness or running its plugins; a hosted multi-user relay; business-ops coworkers (inbox, CRM);
white-labelling; prompt optimisation over transcripts; a native (gpui) Hivra. Each can come back as its own
decision.
