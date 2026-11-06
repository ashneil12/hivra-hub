# MonoCode Hub — the simple plan

19 October 2026. Written from Ash's three messages that day plus a read-only audit of this repo, the studio
(`~/Projects/exo-cc-studio`) and upstream MonoCode v0.16. Ash's words win over anything here.

## What Ash wants (19 Oct)

- Run the business from this app. He loves the MonoCode UI: projects, custom dashboards, teams.
- The leadership team lives here, on Claude Code. The hub runs on its own without Grok Bot. Grok Bot leadership can oversee it and set tasks, but isn't required (decided 20 Oct).
- The chat he talks in owns what he says: it writes every ask down, stores it and delegates. Nothing works on
  a dump outside that chat.
- One small checker (Haiku) compares each dump with what was recorded, delegated and done. It asks the owning
  chat privately ("I noticed this, is this right?"). It never starts work.
- Double delegation: leadership team → project Lead (one long-running coding chat) → subagents, with reports back.
- Named Monos and teams he can create (e.g. marketing). The whole setup and memories import and export. Any
  coding engine.
- Simple. No bloat. Agents more autonomous.
- He talks only to orchestrators, never workers. Agents work at high agency and come back only with something
  important.
- "Go autopilot" (e.g. a weekend away): agents take full control and decide without reporting back. The hub
  manages it.
- Memory in two layers: global (what every agent should know about Ash) and per project. A new project never
  gets another project's memory.
- Whatever is useful from the game studio comes over into MonoCode.

## How it works: MonoCode's own pieces, nothing extra

- **Every agent is a Mono.** That covers the leadership team (Chief of Staff, Projects Manager, frank, Alfred),
  each project's Lead and any new team. Workers are subagents inside a Mono's session. A Mono's chat never
  ends: MonoCode rotates the thread at 80% context (`monoRotation.ts:16`).
- **Delegation is MonoCode's `app` CLI.**
  - `sessions.send` hands a brief to another session in the project.
  - With `notifyOnComplete`, the receiver's final reply comes back as a new turn in the sender's chat. That
    turn is the report-back (`agentApp.ts:248`, `monoSessionCompletion.ts:8`).
  - The delegate/report-back rules are already in every Mono prompt (`monoFiles.ts:348`).
  - We don't use the orchestrator: it needs a plan approval, caps at 4 workers and only uses fresh sessions.
  - On top of that, a small `delegate` MCP tool built on T3 Code's design:
    - its `delegate_task`, `task_status`, `task_cancel` and wait tools
    - waking the parent with the result
    - the instructions that tell an agent when to delegate
  - We copy T3's design, not its engine. That engine is ~76k lines of Node/Effect built around its own event
    store. Bringing it in would mean two backends side by side and no more upstream updates from either. Both
    projects are MIT.
- **The owning chat records the asks.**
  - Each ask is stored with that chat as its owner, then delegated and closed with evidence.
  - No background sorter, runner or lead picks up a dump.
- **The checker is one small Mono on Haiku.**
  - It compares each dump with its owner's asks, delegations and results, then asks the owner when something
    looks missed.
  - It logs the answer. It can message owners, but can't start work.
- **Memory in two layers.**
  - Global (`~/agent-memory/global`, new): only what every agent should know about Ash, whatever the project.
    Short and curated.
  - Per project (`~/agent-memory/<project>`, git per project): decisions, rules, what broke. Recall searches
    this project plus global, never another project.
  - The hub/harness is a project like any other. Today its lines sit in the global `ash` folder and leak into
    every project.
  - The owning chat saves decisions as they happen.
  - Monos use the same store. A Mono's own `MEMORY.md` is only for its persona.
- **Group rooms take turns** (`hub-handoff-2026-10-15/spec-pack/harness-refs/REPORT.md` §1):
  - One agent answers, picked by @mention or a cheap router.
  - Others add at most one reply, and only if it's new.
  - Agent-to-agent exchanges are capped, and one turn is in flight per room.
- **Questions stay in the chat that owns the work**, like Claude projects.
  - Agents decide what they can and ask only what truly needs Ash.
  - Today lists the chats waiting on him, each with its one-line question and the agent's recommended answer.
    One tap takes the pick.
  - The separate question queue goes: 195 are open today, 186 of them older than 3 days.
- **Autopilot** is a switch in the hub, per project or for everything, with an end time.
  - While it's on, agents take their own recommendation on every call except Ash's red list: moving money,
    deleting data without a backup, prod-host maintenance and mass destructive operations.
  - Each call goes into an Autopilot log he skims when he's back.
- **Lanes.**
  - Every ask has one owner, and every delegation is recorded.
  - A Mono reaches only its own projects, through a per-sender allowlist on the `app` control.
- **The hub shows per project:** what is being worked, by whom, what was delegated to whom, and what was done
  with proof.

## What is real today

| Area | Today | Evidence |
| --- | --- | --- |
| Projects strip, Today, Needs you, questions | Real, from the studio ledger | `hubStore.ts:342-522` → `ashos/hub.py` |
| Being built | Real, but fed only by the background runners Ash doesn't want | `ashos/job_sources.py` |
| Leadership group chat | **Simulated**: canned "Example:" replies | `hubChats.ts:227` |
| Real group replies | Uncommitted in `~/Worktrees/monocode-hub-continuation-06`, never checked in the app, no turn-taking | `hubChats.ts:305` (C6) |
| Default team Monos | Stubs: no SOUL text, `projects: []`, so they can't reach anyone | `builtInMonos.ts:7` |
| Project Leads | Real Claude Code sessions; `hub.lead.wake` is never consumed | `hubLeads.ts`, `hubStore.ts:634` |
| Pages, Change the hub | Call studio actions that don't exist → error | `buildPage.ts:45`, `hubChange.ts:62` |
| New project, dashboards, connectors, builds, proposals | Placeholder or local only | `NewProjectView.tsx:94` |
| Dump sorting | Down since 16 Oct (Claude weekly limit, Grok 402). The receipt says it "retries", but 3 failed tries stop it for good | `ashos/intake.py:388`, `core.py:193` |
| Memory | Works, with three faults. The global `ash` layer holds the hub project's own lines (about 56 of 159 decisions), so they reach every project. The "Never do" list loaded at the start turns requests into bans (e.g. "Never do: land work as soon as it is ready"), and a pasted Grok Bot handoff was saved as Ash's rules. Nothing has arrived automatically since sorting died | `~/agent-memory/ash/MEMORY.md`, `never.md:31-36` |
| Upstream | 106 commits behind v0.16. A trial merge hit 8 files, 17 text-only conflicts | trial in a scratch clone |

## Phases

Each phase ends **verified in the installed app** (`~/Projects/harness/WORKING-LOOP.md`): reproduced → changed
→ checks pass → delivered → verified in the app.

**0. Stop the noise.** Needs Ash's go: it changes config and harness switches. Everything here is reversible.
- Pause everything that starts work by itself:
  - `ash runner off`
  - the studio `enable {enabled:false, coordinator:false}` call
  - `lander.paused`
  - unload `exo-merge-queue`
- Switch the background sorter off and keep word-for-word capture. This is a studio change, because it has no
  switch yet. While the lander is paused, studio changes land by hand after its suite and `ash selftest` pass.
- Claude Code:
  - Turn ultracode off.
  - Remove the autonomy-grant, dead Stop and codebase-memory hooks.
  - Replace "call ash_dump first" with "this chat owns it".
- Commit continuation-06 to its own branch so nothing is lost.
- Fix memory (git-backed):
  - Split the global layer from the hub project.
  - Rebuild the Never list from Ash's real bans.
  - Drop the pasted Grok Bot handoff lines.

**1. Catch up with MonoCode v0.16.** Merge upstream, then `hub:check`, `hub:build`, `hub:verify` and
`hub:install`. Ash's conversations must still be intact.

**1b. One app, one clean way to develop it** (Ash 19 Oct: "there's multiple versions of the app ... i'd like a
way to make it easy"; the rest comes from T3 Code's self-hosting setup):
- **Dev slots.** Running the hub from any worktree opens "Hivra Dev - <branch>". It has its own data folder,
  its own port and a DEV ribbon, so it can never touch the daily app's chats, Keychain or Ash OS. (Done: `hub:dev` used
  to run as `com.ash.monocode-hub` on the live data folder; each worktree now runs its own
  `com.ash.monocode-hub.dev.<slot>`, `scripts/hub-dev.mjs`.)
- **One app per data folder.** A second copy says which build owns the data and exits. Every window and bundle shows
  its commit and branch. One command lists every hub bundle, data folder, dev slot and worktree on the Mac.
- **Ship with a safety net.** One Ship command or button installs a verified build into the daily app. It keeps the
  previous app and a database snapshot, rolls back by itself if the new build doesn't boot, and tells the Lead that
  shipped it what happened. (Done: `hub:install` used to be `rm -rf` then `cp -R`; now `hub:ship`,
  `scripts/hub-ship.mjs`, installs, and `hub:install` is only the one-time `--legacy` install, which keeps the old app.)
- **Project file** (`.monocode/project.json`):
  - It sets up each new worktree before the first turn (dependencies, a shared Rust cache).
  - It adds one-click actions: Run dev slot, Check, Ship.
- **Worktree janitor.** A dry-run report of every worktree (size, merged or dirty). Nothing is removed without
  Ash's OK.
- **Restart-safe resume.**
  - A Lead cut off by an install or crash resumes with a note of what was cut.
  - A turn that keeps crashing stops after three tries.
- **Fake-Claude test bench.** It proves the whole delegation chain end to end with no tokens spent.
- Then the hub itself is the place to develop the hub: its own project, its own Lead, dev slots to see changes,
  Ship to land them.

**2. The chat owns its asks + the checker.**
- Ledger additions:
  - an owner (session or Mono id) on each ask
  - a delegation record: to whom, brief, when, report-back
  - who changed each status
- One tool for the owning chat: record asks against the dump, and mark them delegated or done with evidence.
- "Being built" reads from those records, replacing the runner feeds.
- The `delegate` tool, following T3 Code's design, on MonoCode's `app` control.
- The checker Mono on Haiku.
- From T3 Code:
  - **Delegations survive restarts.** Owed reports are stored and recovered when the app starts, so a Lead always
    gets exactly one report. (Done: they used to live only in memory, `App.tsx:8586`; each is now a row in the hub's
    database, `src-tauri/src/delegations.rs`, recovered when the app starts.)
  - **Workers ask their Lead, not Ash.** A worker's question wakes the chat that delegated it. Only real choices go up
    to Ash, with the Lead's recommendation.
  - **A delegation tree you can see and stop.**
    - One Stop on a Lead stops everything under it.
    - Lead chats show one counted line per batch, e.g. "Delegated 3: 2 working, 1 failed".
    - A waiting Lead shows "Waiting on 3".
  - **Honest turn results.** A worker that died on a 402, 502 or overload is reported as failed with the reason, not
    as completed (`claudeProtocol.ts:480`).
  - **`/goal`.** A brief can carry a done condition that the worker keeps going until it meets.

**3. Real leadership team + double delegation.**
- SOULs for the team, with their personas brought over from Grok Bot.
- Project membership, so the team can reach the Leads.
- Real group replies (finish continuation-06) plus the turn-taking rules.
- Leadership → Lead via `sessions.send` + `notifyOnComplete`. Briefs queue while a Lead is busy, because busy
  targets are refused today.
- Questions move into the owning chats, Today lists who is waiting, and the question queue is retired.
- The autopilot switch and its log.
- From T3 Code:
  - **Briefs to a busy chat** queue or steer instead of failing.
  - **Autopilot survives limits, crashes and sleep.**
    - Agents resume by themselves when a usage limit resets.
    - The app relaunches after a crash.
    - The Mac stays awake until autopilot ends.
  - **Claude Code workflow runs** show their phases and agents, not a spinner.
  - **Long-running chats** compact at a sensible size, and model or permission changes apply live.

**4. Run the business from the app.**
- Pages and dashboards backend.
- Change the hub.
- A real New project flow.
- Teams and named Monos (marketing).
- Connectors: direct with Keychain, Composio optional.
- Port the game studio:
  - The EXO skills already work in any Claude Code chat.
  - Its roles become Mono SOULs.
  - Keep the per-project worker limit (game work throttled) and the verification gates.
  - The controller, the EXO lead loop, the runners and the merge queue are replaced by the EXO Lead
    delegating.
- From T3 Code: **PR and CI watch.** A Lead registers its PR and is woken only when checks fail or pass, someone
  comments, or the branch conflicts. Built 20 Oct on `hub/4-prwatch` (`src-tauri/src/pr_watch/`; design notes kept locally).

T3 Code ideas we skip, with reasons, are in the 19 Oct harvest. Among them: usage-cost pages, the cloud relay,
webhook triggers (a prompt-injection door into the Mac) and line-by-line PR review tools.

**5. Portable.** Built on `hub/5-import-export` (docs/PORTABLE.md).
- Setup export/import v2: Monos, skills, chats, memory if ticked, connectors without secrets.
- Engine per Mono.

## Cut once phase 2 replaces it

- Studio, about 7k lines: runner, lander (all but landing main), controller, EXO lead coordinate, job feeds,
  triage gating, settle, `bin/runner-guard`.
- Disk:
  - about 45 stale worktrees (31 GB in `~/Worktrees`)
  - the reference clones in `hub-handoff-2026-10-15`
- Nothing is deleted without Ash's OK.
