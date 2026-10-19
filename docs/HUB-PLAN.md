# MonoCode Hub — the simple plan

19 October 2026. Written from Ash's two messages that day plus a read-only audit of this repo, the studio
(`~/Projects/exo-cc-studio`) and upstream MonoCode v0.16. Ash's words win over anything here.

## What Ash wants (19 Oct)

- Run the business from this app. He loves the MonoCode UI: projects, custom dashboards, teams.
- The leadership team lives here, on Claude Code. Grok Bot is no longer used.
- The chat he talks in owns what he says: it writes every ask down, stores it and delegates. Nothing works on
  a dump outside that chat.
- One small checker (Haiku) compares each dump with what was recorded, delegated and done. It asks the owning
  chat privately ("I noticed this, is this right?"). It never starts work.
- Double delegation: leadership team → project Lead (one long-running coding chat) → subagents, with reports back.
- Named Monos and teams he can create (e.g. marketing). The whole setup and memories import and export. Any
  coding engine.
- Simple. No bloat. Agents more autonomous.

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
- **The owning chat records the asks.**
  - Each ask is stored with that chat as its owner, then delegated and closed with evidence.
  - No background sorter, runner or lead picks up a dump.
- **The checker is one small Mono on Haiku.**
  - It compares each dump with its owner's asks, delegations and results, then asks the owner when something
    looks missed.
  - It logs the answer. It can message owners, but can't start work.
- **One memory.** `~/agent-memory/<project>` (git per project) plus recall.
  - Monos read and write it through the ash-os tools.
  - A Mono's own `MEMORY.md` is only for its persona.
- **Group rooms take turns** (`hub-handoff-2026-10-15/spec-pack/harness-refs/REPORT.md` §1):
  - One agent answers, picked by @mention or a cheap router.
  - Others add at most one reply, and only if it's new.
  - Agent-to-agent exchanges are capped, and one turn is in flight per room.
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
| Memory | Works, but polluted: a pasted Grok Bot handoff was saved as Ash's rules; most `never.md` lines are requests | `~/agent-memory/ash/never.md:31-36` |
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
- Clean the memory pollution (git-backed).

**1. Catch up with MonoCode v0.16.** Merge upstream, then `hub:check`, `hub:build`, `hub:verify` and
`hub:install`. Ash's conversations must still be intact.

**2. The chat owns its asks + the checker.**
- Ledger additions:
  - an owner (session or Mono id) on each ask
  - a delegation record: to whom, brief, when, report-back
  - who changed each status
- One tool for the owning chat: record asks against the dump, and mark them delegated or done with evidence.
- "Being built" reads from those records, replacing the runner feeds.
- The checker Mono on Haiku.

**3. Real leadership team + double delegation.**
- SOULs for the team, with their personas brought over from Grok Bot.
- Project membership, so the team can reach the Leads.
- Real group replies (finish continuation-06) plus the turn-taking rules.
- Leadership → Lead via `sessions.send` + `notifyOnComplete`. Briefs queue while a Lead is busy, because busy
  targets are refused today.

**4. Run the business from the app.**
- Pages and dashboards backend.
- Change the hub.
- A real New project flow.
- Teams and named Monos (marketing).
- Connectors: direct with Keychain, Composio optional.

**5. Portable.**
- Setup export/import v2: Monos, skills, chats, memory if ticked, connectors without secrets.
- Engine per Mono.

## Cut once phase 2 replaces it

- Studio, about 7k lines: runner, lander (all but landing main), controller, EXO lead coordinate, job feeds,
  triage gating, settle, `bin/runner-guard`.
- Disk:
  - about 45 stale worktrees (31 GB in `~/Worktrees`)
  - the reference clones in `hub-handoff-2026-10-15`
- Nothing is deleted without Ash's OK.
