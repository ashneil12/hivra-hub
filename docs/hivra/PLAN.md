# Hivra: the build plan

57 work packages in ten waves. A wave's packages run in parallel; a package starts when everything it depends on
has merged. Sizes are agent time: S is under two hours, M is half a day, L is about a day.

## How to take a package

1. Read [README.md](README.md), [SPEC.md](SPEC.md), this file, then your package in [work/](work/).
2. **Claim it** by opening a draft PR titled `WP-NN: <title>` as soon as you start. Open PRs are the status board;
   don't take a package that already has one.
3. Branch from `main` as `wp/NN-short-name`.
4. Stay inside the paths your package owns. If you must touch another package's paths or a shared hotspot
   (`src/app/App.tsx`, `src-tauri/src/lib.rs`, `src/features/settings/ui/SettingsView.tsx`), keep it to a small hook
   and say so in the PR.
5. Write the tests first where you can. Before marking the PR ready: `npm run check` passes, and for anything a
   person sees, a browser spec in `tests/browser/` passes and a screenshot is attached.
6. Put the evidence in the PR description: what you ran, what it printed, what you couldn't check (native window,
   real provider) and why.
7. One package per PR. Credit sources from [SOURCES.md](SOURCES.md) in the PR and in `NOTICE` when code is
   vendored.
8. Follow [AGENTS.md](../../AGENTS.md): never launch a build with the real HOME, never touch the daily app or its
   data, ship only through `hub:ship`.

## Review and landing

- Every PR gets a review by a Claude agent that did not write it, against the package's "Done when" list.
- PRs from Grok (or any agent Ash is unsure of) are welcome for packages marked **Grok OK**, and get the same
  review plus a check that nothing outside the package's paths changed.
- Native checks (anything only the real window shows) run in a dev copy on Ash's Mac (`npm run hub:dev`), started
  by Ash or through a Remote Control session. A package that needs one stays open until it is done; tests passing
  is not the same as verified in the app.
- The integrating Claude merges, with a merge commit, once the review passes and CI is green, or once the only
  failures left are ones `main` already has and the PR says so. Ash doesn't need to be asked. Nothing is shipped to
  the daily app until a wave is merged and checked in a dev copy.

## Upstream rules (every package)

- New features go in new modules. Upstream files get the smallest hook that works, with a comment naming the
  package.
- Don't reformat or reorder upstream code. Don't rename upstream symbols.
- Upstream is merged regularly (AGENTS.md "Upstream merges"). A package that conflicts with a fresh upstream merge
  rebases; it doesn't fight upstream.

## The waves

### Wave A: clean base and foundations (start now, all in parallel)

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [01](work/WP-01-browser-tests.md) | Browser tests green | M | none | yes |
| [02](work/WP-02-windows-tests.md) | Windows tests green | M | none | no |
| [03](work/WP-03-one-layout.md) | One layout | M | none | no |
| [04](work/WP-04-retire-ash-os-bridge.md) | Retire the Ash OS bridge | L | none | no |
| [08](work/WP-08-credits.md) | Credits and notices | S | none | yes |
| [10](work/WP-10-first-mate-contract.md) | First mate contract | L | none | no |
| [22](work/WP-22-groups.md) | Groups: responder modes and goal mode | M | none | no |
| [30](work/WP-30-plugin-format.md) | Plugin format and registry | L | none | no |

### Wave B: the first mate's engine and plugin installs

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [05](work/WP-05-personas-to-monos.md) | Leadership personas become Mono templates | M | 10, 16, 30 | no |
| [11](work/WP-11-watcher.md) | Watcher and wake queue | L | 10 | no |
| [12](work/WP-12-delivery.md) | Delivery modes and merge authority | M | 10 | no |
| [13](work/WP-13-crew-routing.md) | Crew routing and reroute | M | 10, 16 | no |
| [16](work/WP-16-retire-grok-bridge.md) | Retire the Grok bridge | M | 01, 22 | no |
| [14](work/WP-14-steering-decisions.md) | Steering and decisions | M | 10 | no |
| [40](work/WP-40-gates.md) | Completion and verdict gates | M | 10 | no |
| [31](work/WP-31-plugin-install.md) | Plugin install, update, rollback | L | 30 | no |
| [32](work/WP-32-discover.md) | Discover | M | 30 | yes |
| [41](work/WP-41-pstack.md) | pstack in every chat | S | 30 | yes |
| [45](work/WP-45-pstack-autopilot.md) | pstack autopilot and plain-English endings | S | 10, 41 | yes |

### Wave C: what people see

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [15](work/WP-15-first-mate-ui.md) | First mate UI: Crew tab and Inbox | L | 03, 10, 11, 14 | no |
| [06](work/WP-06-retire-hub-screens.md) | Retire Today, Being built, Needs you | M | 15 | no |
| [20](work/WP-20-coding-team.md) | Coding team as every project's first mate | M | 11, 12, 13, 15 | no |
| [21](work/WP-21-monos-first-mates.md) | Monos are first mates | M | 05, 20 | no |
| [23](work/WP-23-council.md) | Council | L | 22 | no |
| [33](work/WP-33-panels.md) | Pages become panel plugins | M | 04, 31 | no |
| [34](work/WP-34-creator-mode.md) | Creator mode | L | 31, 33 | no |
| [42](work/WP-42-e2e-plugin.md) | e2e Verify plugin | S | 31 | yes |
| [43](work/WP-43-browser-plugin.md) | Browser plugin | M | 31 | yes |
| [44](work/WP-44-desktop-plugin.md) | Desktop control plugin | S | 31 | yes |

### Wave D: later (start when Ash says)

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [07](work/WP-07-rename.md) | Rename the app to Hivra | M | 06 | no |
| [09](work/WP-09-platform-parity.md) | Ship and autopilot on Windows and Linux | L | 02 | no |
| [50](work/WP-50-history-importer.md) | Chat-history importer | L | 21 | no |
| [51](work/WP-51-memory.md) | Memory curator, review screen, long chats everywhere | L | 50 | no |
| [60](work/WP-60-host-side-first-mate.md) | First mate on the remote host | L | 20 | no |
| [61](work/WP-61-hivra-cloud.md) | Hivra Cloud machine | L | 60 | no |

### Wave E: tasks, docs and safety nets (from Orbit, Ash 4 Nov)

Ash looked at [Orbit](https://github.com/coollabsio/orbit) and wants its tasks and boards, docs, home, finder and
team collaboration, plus checked backups, trash, GitHub issues as briefs, an activity log and a door for outside AI
tools. The point he liked most: seeing what the agents are doing, as tasks. Orbit is Apache-2.0 and the same Rust and
React stack, so copy its code with credit and make it sleeker. 70, 72, 75, 76 and 78 start at once.

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [70](work/WP-70-tasks.md) | Tasks, shared by the person and their agents | L | none | yes |
| [71](work/WP-71-boards.md) | Boards: kanban, list and timeline | L | 70 | yes |
| [72](work/WP-72-docs.md) | Docs | L | none | yes |
| [73](work/WP-73-home.md) | Home | M | 70, 72 | yes |
| [74](work/WP-74-finder.md) | Finder (one search box for everything) | M | 70, 72 | yes |
| [75](work/WP-75-backups.md) | Checked backups, and restoring one thing | M | none | yes |
| [76](work/WP-76-trash.md) | Trash | M | none | yes |
| [77](work/WP-77-github-issues.md) | GitHub issues become briefs | M | 70 | yes |
| [78](work/WP-78-activity-log.md) | Activity log | M | none | yes |
| [79](work/WP-79-outside-tools.md) | A safe door for outside AI tools | L | 70, 72 | yes |
| [80](work/WP-80-team-workspaces.md) | Team workspaces (start when Ash says, after 61) | L | 61, 70, 72 | yes |

### Wave F: checked delivery, ready worktrees, learning from chats (Kun Chen's tools, Ash 4 Nov)

Ash shared five of Kun Chen's repos (firstmate's author). no-mistakes and treehouse are MIT Go tools that release
almost daily, so Hivra uses them as pinned tools instead of porting them. backpass is MIT JavaScript, so its rules are
copied in. kun and the dotfiles give two smaller ideas folded into 83. 81 and 82 start at once; 83 starts when 51
merges.

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [81](work/WP-81-delivery-gate.md) | Every crew's work is checked before it reaches GitHub | L | none | yes |
| [82](work/WP-82-worktree-pool.md) | Ready worktrees for every crew | M | none | yes |
| [83](work/WP-83-learn-from-chats.md) | Agents learn from past chats, with evidence | L | 50, 51 | yes |

### Wave G: research before building, terminal sessions, commit attribution, per-worktree stacks (HumanLayer, Ash 4 Nov)

Ash shared HumanLayer, the closest look-alike of Hivra so far. It is Apache-2.0, so its code is copied with credit.
Its cloud sync (Postgres and Electric, a hosted API) is heavier than local-first Hivra needs and stays a reference
for WP-61 and WP-80. 84 starts when 70 and 72 merge, 85 and 86 when 70 (and 78) merge, 87 when 82 merges.

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [84](work/WP-84-research-plan-build.md) | Big tasks are researched and planned before they are built | L | 70, 72 | yes |
| [85](work/WP-85-terminal-sessions.md) | Claude Code sessions started in a terminal show up in Hivra | L | 50, 70 | yes |
| [86](work/WP-86-commit-attribution.md) | Every commit says which agent, chat and task made it | M | 70, 78 | yes |
| [87](work/WP-87-worktree-stacks.md) | Each worktree runs its own copy of the project without clashes | M | 82 | yes |

### Wave H: one place to see everything (Ash, 5 Nov)

Before the first ship, Ash asked what would tie everything together: a Home overview he can arrange, and one agent
that knows every project. Home (73) now takes pinned panels and a chosen order; 88 gives the existing Chief of Staff
a read-only view across projects and puts its chat on Home. 88 starts when 51, 70, 72, 73 and 78 have merged. 89 lets
the person set the workers' CLI, model and effort for one Mono, one project or everything, on screen or by telling the
first mate.

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [88](work/WP-88-chief-of-staff.md) | The Chief of Staff knows every project | M | 51, 70, 72, 73, 78 | yes |
| [89](work/WP-89-worker-model.md) | Change what your workers run on, anywhere, in one step | M | 13 | yes |

### Wave I: secrets that never reach the model (Ash, 5 Nov)

Ash asked for the thing he does by hand today: an agent that needs a key asks for it, the person pastes it once into a
form card in the chat, and it goes straight into the Mac's keychain. Later the agent names it ("use my Stripe key"),
the app hands it to one approved command for one run, and the agent sees only output with the value taken out. It
replaces the current "Needs Ash (provide)" paste, which writes the key into the transcript. It starts now, and takes
WP-14's asking mechanics when they merge.

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [92](work/WP-92-secret-vault.md) | Agents ask for a secret and use it without ever seeing it | L | none | no |

### Wave J: a web address per worktree, and fake outside services (portless and emulate, 5 Nov)

Ash found portless and emulate (both Apache-2.0) and asked whether they would let parallel agents run apps and
browser-test without colliding on ports, cookies, hostnames or shared outside accounts. Ports were already covered by
WP-87; 90 adds a name per worktree and a local stand-in for each outside service, so a crew's tests use fake accounts.
It builds on 87's stack, so it starts when 87 merges.

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [90](work/WP-90-portless-emulate.md) | Every worktree gets its own web address, and its tests meet a fake service | L | 82, 87 | yes |

### Wave K: the goal graph (oh-my-hermes, 5 Nov)

Ash shared oh-my-hermes (MIT, read at commit `2676c33`) and asked for Hivra's way of running big work to be the
best one. Most of its graph planner is already in Hivra's orchestration run: required file scopes, isolated
checkouts, dependency-ordered dispatch, review before acceptance, failure contained to the downstream. WP-91 adds
the parts Hivra lacks: one goal and a finish-line check proved before work, a baseline, scope checks when the plan
is approved, a required verify task and a run verdict, plus a live graph. It extends the orchestration run and
WP-40's gates; it adds no second run model. It starts when 40 and 82 merge, and 14 for the approve step.

| WP | Title | Size | Depends on | Grok OK |
| --- | --- | --- | --- | --- |
| [91](work/WP-91-goal-graph.md) | The goal graph: a finish line proved first, and a live view of the run | L | 14, 40, 82 | yes |
| [174](work/WP-174-idle-reclaim-and-hibernation.md) | Idle reclaim and hibernation, a quiet chat gives back its process | M | 11, 146 | no |
| [177](work/WP-177-teleport-chat-between-machines.md) | Teleport a chat between this Mac and a host, as a custody handover | L | 60, 61, 121, 133 | no |
| Follow-up to [160](work/WP-160-lead-tick.md) | The lead tick opens the PR watch and the delivery row itself, so Ship on green can merge without asking | S | 160 | no |

## Running it

- Each wave runs as one agent per package, in parallel (up to about ten at once). Wave A can start the moment this
  plan merges. A wave usually takes a day of agent time; the slow part is review and the dev-copy checks on Ash's
  Mac, so plan those in batches at the end of each wave.
- A package whose dependency sits in the same wave starts when that dependency's PR merges, or branches from that
  PR's branch and says so in its own PR (then it merges second).
- The integrating agent (Claude, in the project's main thread) keeps the board: watches the PRs, re-runs CI, resolves
  conflicts between packages, and tells Ash only what needs a decision or a merge.
- After each wave: merge upstream if it moved, run `npm run hub:verify-live` once as the end-to-end proof, then ask
  Ash whether to ship the wave to the daily app.

## Risks to watch

- **`App.tsx` conflicts.** It is about 17,000 lines and several packages hook into it. Keep hooks small, merge
  App.tsx-touching PRs one at a time, rebase the rest.
- **Retiring code that is still used.** Packages 04, 05, 06 and 16 search for every caller and remove code and tests
  together; the daily app keeps running its shipped build until Ash ships the wave.
- **Native-only behaviour.** Browser specs can't see the native window. Any package touching windows, menus,
  Keychain, or the bundle keeps its dev-copy check open until done.
- **Licences.** Any vendored file goes through [SOURCES.md](SOURCES.md)'s rules.

## Ideas from kitze's factory teaser (5 Nov)

Ash watched kitze's factory teaser and asked what of it Hivra should take. It is a product tour, not a repository,
so nothing is credited and no source is added to SOURCES.md. Each candidate below says what Hivra already has and
what is missing, so any of them can become a package when Ash says. None has a WP doc yet.

1. **An automations factory canvas.** Hivra has automations that run on a time or a GitHub or GitLab event, with a
   list of runs (`src-tauri/src/automations.rs`), and the activity log (WP-78). Missing: a webhook trigger, a canvas
   that shows the graph of what feeds what, and a live activity feed of runs ("Webhook received", "Automation
   completed", "Automation failed" with the reason in plain words).
2. **A Machines view.** Hivra knows this Mac, the remote host (WP-60, WP-61) and the phone, and it checks each
   CLI's version with the right update command for Claude Code, Codex, opencode and Pi
   (`src-tauri/src/harness_updates.rs`). Missing: every machine as a card (Mac, VPS, Proxmox hosts, phone), Cursor and
   Gemini in the harness list, a harness × machine version matrix, and one-click Update that reaches a machine other
   than this one.
3. **Agents as bots.** Hivra has Monos with a persona (WP-05, WP-21), a harness and model per Mono (`MonoEngine`), a
   worker default per Mono, project and app (WP-89), crew rules that reroute after a failure (WP-13), and skills and
   commands that come with plugins (WP-30, WP-41). The teaser's per-bot settings are role, provider and model, an
   ordered fallback list of provider and model, effort from Low to Max, fast mode, and the bot's own Commands and
   Skills lists. Missing: one bot card that shows all of it together, an ordered fallback list on the bot itself,
   fast mode, and the bot's own Commands and Skills lists.
4. **A chat doctor.** Hivra resumes a turn cut by a quit or a crash (up to 3 times), starts fresh from its brief when
   a chat's transcript is gone, says "resume stopped" in the chat, and has `monocode healthcheck` for the database.
   Missing: a pass that finds broken chats by itself (lost transcript, a turn that never ends, a session that fails
   on every message) and repairs them, with a list of what it found and what it did.
5. **A Commands and Skills library page.** Hivra gets skills and commands from plugins (WP-30, WP-31, WP-41), and the
   finder (WP-74) searches tasks and docs. Missing: one page that lists every command and skill with its plugin,
   counts and search.
6. **A Home "Everything" view.** Hivra's Home is a column of movable sections with a pinned panel (WP-73), beside
   Tasks (WP-70), the Chief of Staff's view across projects (WP-88) and decisions (WP-14). Missing: one plain-language
   paragraph of what is going on now ("16 agents are working… 55 decisions are waiting on you…"), workspace cards,
   to-dos with draft and ready, and notes and a scratchpad on Home. WP-73 rule 6 forbids counters on Home on purpose;
   the paragraph fits that rule, and the cards' counts would need Ash to reopen it.
7. **A Today page.** Hivra has the activity log (WP-78), tasks with their states (WP-70) and sessions (the old Today
   screen was retired in WP-06 because it showed chat state rather than a day's work). Missing: what was worked on
   today or any other day by date, grouped by status or anything else; time worked with an hourly bar; messages sent
   and received; to-dos finished by agents against waiting for review (accepted, returned); decisions made
   automatically against made by the person; chats active against done.

## From oh-my-hermes (5 Nov)

Ash shared [oh-my-hermes](https://github.com/rlaope/oh-my-hermes) (MIT, read at commit `2676c33`), a Python operating
layer that sits beside Hermes Agent, so this is what it adds on top of the Hermes Hivra already drives as one of its
harnesses (`src/integrations/harness/providers/hermes/`). Each item says what Hivra has and what is missing; the graph
planner has its own package, WP-91. Copied with credit, if 91 is taken: `dag_core.py` and `dag_run.py`, translated to
Rust. The rest are ideas only.

1. **The goal graph (dag-ulw), as WP-91.** Hivra's orchestration run already requires file scopes per task, gives each
   worker an isolated checkout, dispatches in dependency order and accepts only on review. Missing: one run goal and a
   finish-line check run, and seen failing, before work, a baseline, a plan-time check that two parallel tasks never
   share a write scope, a required verify task and a run verdict, and a graph view. WP-91 adds those and changes no
   existing run model.
2. **Per-lane model chains.** Hivra has one model and effort per route, with precedence, skip reasons and a CLI-level
   reroute after a failure (`src-tauri/src/crew/resolve.rs`, `crew/reroute.rs`). Missing: an ordered chain per kind of
   work (deep, quick, review, visual), each with its effort rung and the next candidate named when a provider refuses a
   model; today that refusal is retried only for the Claude Code proxy (`model_router.rs`).
3. **Reasoned memory.** WP-51 plans a curator, a review screen and fenced recall. Missing: an admission state for every
   fact with a written reason for keep, refuse or defer, duplicate hints, and a ranked recall pack under a token budget
   that says what it left out and why.
4. **Two-axis evidence labels.** Hivra derives five statuses and WP-40's verdict in code. Missing: the same evidence in
   the task's words, separating the phase from the proof ("Plan · not run", "Code · reported done", "Test · verified"),
   so a worker's report can never read as a verified test.
5. **A deterministic skill router.** Hivra lists skills and slash commands and receives plugins' routing (WP-30, WP-41,
   WP-45). Missing: a phrase-and-token router that picks a skill and its instruction at message time, with guardrails
   and negative controls, rather than an always-on index.
6. **LSP tools.** Hivra exposes no definition, references, rename or diagnostics tool to a Hermes worker (its own CLI
   may have them). Missing: those tools, with UTF-16 positions and a fail-closed "no language server" answer.
7. **A Hermes doctor.** `npm run hub:doctor` checks the app's identity, bundles, data folders and worktrees. Missing:
   one pass over the Hermes path itself, install, auth, profile, language server and memory database, with a short
   ordered list of what to fix and privacy flags that keep personal files out of the report.

## From Aether (5 Nov)

Ash shared [Aether](https://runaether.dev), a closed-source product, so this is ideas only: no code, nothing credited.
Its campaigns (a lead splits a job across sub-agents, each in its own devbox on its own branch, and one pull request
comes back) is what Hivra's orchestration run already does, so it is not a candidate. The gaps:

1. **A machine per task.** Hivra has a warm worktree pool that keeps installs and build cache (WP-82), and a remote
   host and cloud machine (WP-60, WP-61). Missing: a disposable machine boundary per task (Aether uses a fresh
   Firecracker microVM, never reused), suspend when idle, destroy when the pull request merges or closes or after 48
   hours, and a measured ready time. The site says about five seconds, not twenty (its CLI shows 4.7 s), and warm slots
   are the reason.
2. **The person's own subscription, for one session.** Hivra runs Claude Code, Codex and the rest on the person's own
   logins on this Mac, and WP-89 sets model and effort per task. Missing: carrying that subscription or key to a cloud
   machine for the length of a session and revoking it after; WP-60 and WP-61 never say how the host gets the
   credential, and export and dev-copy rules strip secrets on purpose.
3. **Watching and steering from the phone.** Hivra's paired phone can watch a live conversation, send, answer
   questions, start a session, cancel, rename and archive, and read project files, search and git. Missing: it relays
   through the open desktop window, so it stops when the laptop closes; no terminal in the task's machine; no Inbox of
   tasks and decisions, and no pull-request review or approve on the phone; no reply by email that resumes a run.
4. **Works when the laptop closes.** Hivra plans this in WP-60 (delegations, the wake queue and the classifier move to
   the remote host) and WP-61 (the cloud machine, routines with safety caps and an away feed). Missing: the service
   that provisions machines is outside WP-61's scope; automations and routines still fire from the desktop row, so a
   schedule while the laptop is off needs the host to own them too; the caps cover routines, not every unattended run.
5. **A reviewer that runs the changed code.** Hivra has WP-40's gates and verdict, WP-81's pre-GitHub gate (review,
   tests, docs and lint in a throwaway worktree, then CI repair), e2e evidence from WP-42 and WP-43, and PR watch.
   Missing: an independent reviewer that boots the changed app and files findings from the running app as a pull-request
   verdict (WP-42 is the worker proving itself); before-and-after screenshots and a session video; reviewing every new
   pull request in a connected repository whoever wrote it, and re-reviewing each push until approve; fork pull
   requests reviewed read-only.
