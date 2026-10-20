# Sources, confidence, and gaps

Research was read-only. Nothing outside this folder (and its sibling `work/` scratch folder) was written. No secrets are reproduced.

## 1. How verbatim is each persona?

| Agent | Verbatim config in Grok Bot | How the rest of the SOUL was built |
|---|---|---|
| Chief of Staff | 359 chars now (136 chars on 17 Sep, before "skill gardening" was added). "Business partner for Ash: runs Hivra, Nibbii, and Operator OS across coding, marketing, X, and ops. Pulls Ash in for RED-line decisions." | Inferred from several hundred CoS messages (Sep export, 14-15 Oct 1:1, 15 Oct Leadership Board), the RED lists in the dept-lead configs, Ash's 28 Sep correction, the later Hermes CoS profile. |
| Projects Manager | 417 chars (194 on 16 Sep). | Inferred from the Sep register era (51-71 entries) and the Oct hub-plan era (136 entries, 50 Board messages). |
| frank | 1,981 chars. By far the richest real persona (jobs, memory write rules, anti-jobs, voice, wake). | Config is the spine; behaviour and voice from his 1:1 (87 entries) and 28 Board messages. |
| Alfred | 270 chars. | Only 13 entries in his 1:1 and 7 Board messages in the window, plus his lines in the hub spec log. Thinnest evidence of the five. |
| Critiquito | 168 chars, plus a verbatim self-introduction on 14 Oct (4 entries). | Inferred from 28 Board messages, the hub design rules and the `hub-ui-check` skill. |
| dr eggbot (optional) | 392 chars. | His own persona pack (24 Sep) is lost; see gaps. |

In Grok Bot the `description` field IS the whole persona (dr eggbot said so on 16 Sep, "Description IS the whole persona"). The five leadership configs are short because four of them read like Grok Bot gallery cards (same one-liner style as Writing Bot, SEO & AEO Desk, Nightly Audit Engineer, Lingxi's Engineer Bot). **That is my inference, not a fact in the data.** What made them feel like a team came from chat instructions, skills on the box and Notion, none of which is recoverable here.

All the verbatim text is in `VERBATIM-GROK-CONFIG.md`, copied by script from the roster, unedited. The SOUL files are drafts in my words, labelled so; short quoted lines in each SOUL are real lines (em dashes removed where I quoted).

Confidence labels used in ROOM.md: [V] verbatim, [O] observed in transcripts, [L] locked in hub decisions, [I] my inference.

## 2. Exact sources read

**Grok Bot app (primary)**
- `~/Library/Application Support/Grok Bot/sand-client-persistence/*.blob`. File names are base32 of the key. Read with the same logic as `~/Projects/exo-cc-studio/ashos/sweep.py` (`_grok_blob_key`, `_grok_room`).
  - `...roster.last-roster`: 64 rows with `id, name, description, createdAt, updatedAt, path, lastEntry, isGroup, memberIds`. The persona text is `description`.
  - 26 x `...transcript.replicas.<agent id>`: each holds at most about 200 entries. Windows: Leadership Board 15 Oct 17:19 to 20:54 (198 entries); Chief of Staff 14 Oct 03:23 to 15 Oct (200); Projects Manager 16 Sep to 15 Oct (136); frank 23 Sep to 15 Oct (87); Alfred 14-15 Oct (13); Critiquito 14 Oct (4); dr eggbot 16 Sep to 24 Sep (31); Hivra Canary 12 Sep to 15 Oct (190); Dept Leads, Dev Team seats, SEO & AEO Desk (a handful each).
- Group room membership from the roster: Leadership Board = Chief of Staff, Projects Manager, frank, Alfred, Critiquito (created 16 Sep; Alfred and Critiquito joined 14-15 Oct).
- Not opened on purpose: `sand-secrets.json`, `gateway-descriptor.json`, `Cookies`, `box-secrets-push-state.v1.json`, `sand-statsig-bootstrap.json`. I ran a names-only search (grep -l, file names printed) of the app folder for the agent names; only the blobs matched.

**Older export of the same store (fills 16-29 Sep)**
- `~/grokbot-migration/exports/*.md`, `~/grokbot-convos/*.md` and `~/grokbot-convos/all-entries.jsonl`: 861 entries, 24 rooms, 16-29 Sep (Chief of Staff 197, Leadership Board 200 for 22-28 Sep, Projects Manager 71, frank 41, dr eggbot 31, dev teams). I used the jsonl for the 28 Sep anti-echo exchange, the 24 Sep soul-pack exchange, the Friday retro and Monday kickoff.
- `~/grokbot-migration/roster-full.json`: an earlier roster snapshot (CoS 17 Sep, PM and eggbot 16 Sep descriptions). `~/grokbot-migration/generated/<slug>/SOUL.md` is a Hermes wrapper around the verbatim description; it adds no new persona.

**Memory (Ash OS)**
- `~/agent-memory/hub/MEMORY.md` and `decisions.md`, notably lines 16 (Alfred's pushback and frank's quiet upkeep), 21 (comments to the group), 25 (leadership team is a chat area), 28 (Monos added to any group chat), 38 (bots will be Monos), 40 (keep group chat and 1:1), 41 (default team; Critiquito add-on), 44 (right bot answers, others chime in once, nobody loops), 46-47 (import brings roles, rules, skills; hub rules locked with the team), 67 (Ash stops using Grok Bot), 69-70 (double delegation; named Monos and teams), 75 (follow frank's corrections), 79 (child chats).
- `~/agent-memory/ash/MEMORY.md` (how Ash works; talks only to orchestrators).

**Ash's exact words** (the memory lines are truncated to 200 characters)
- `~/.local/share/exo-cc-studio/ashos.db`, opened read-only with `immutable=1`; tables `dumps` and `segments` (source = grokbot) for dumps d_10140c7d8f, d_1014e4f480, d_1014573e77, d_1014badf40, d_1014442d2c, d_1014162e88.
- Claude session `~/.claude/projects/-Users-ash-Projects-boxin-game-/cad7ffce-ed5a-473b-a0b5-6142385d0676.jsonl`: Ash's 14 Oct 23:25 voice message pasted into Claude Code, which contains the default-team and "right person answering" remarks.
- `deja search --role user` for the "dream org" line (18 Sep, session 3383c61e).

**Hub design and handoff**
- `~/Projects/hub-handoff-2026-10-15/handoff/{README,decisions,gaps,references}.md`, `.../spec-pack/hub-spec/SPEC.md` (the decision log at lines 395-429 is the room's own record of 14 Oct), `DESIGN-RULES.md`, `monocode-design-notes.md`, and the four skills under `handoff/skills/` (`set-up-a-mono`, `hub-ui-check`, `check-build-against-owner-s-words`, `build-a-project-dashboard`). The first three are effectively Alfred's, Critiquito's and frank's working methods.
- Hub repo stubs: `~/Worktrees/monocode-hub-next/src/features/hub/model/builtInMonos.ts`, `roleNames.ts`, `setupSouls.ts`; `.../src/features/monos/model/monoFiles.ts` (SOUL.md, MEMORY.md, habits.json; `setupSouls.ts` reads the first line under `## Role` and bullets under `## Skills`, which these drafts follow).

**Secondary, derived by other agents (used for cross-checks only)**
- `~/ash-corpus/analysis/grokbot.md` (agent-side analysis of the Sep export), `~/ash-corpus/mine-2026-10-09/findings-grokbot.md` and `grokbot-ash.md` (Ash's own messages), `~/.buzz/RESEARCH/GROKBOT_SYSTEMS_MINING.md`, `~/.hermes/profiles/chief-of-staff/SOUL.md` and `~/ash-corpus/profiles/chief-of-staff.md` (a later Hermes-era CoS profile, not Grok config; I used it only for the anti-echo line and the dictation-decoding habit, marked inferred).

## 3. Not recovered (so the SOULs cannot be as faithful as Ash wants)
1. **Box-side agent stores.** The roster `path` is `/home/box/sand-data/agents/<id>/store.db`. Anything the agents knew beyond `description` (private memory, the full system prompt if different, routines' bodies) lives there. It is not on this Mac.
2. **Notion.** What's true, Proposed memories, Decisions, Outcome Register, Org hub and the SOPs ("Ash how-to (daily view)", "New employee Notion SOP", "PM cleanliness checklist") are not readable here; I only have fragments quoted in transcripts. These rows were the org's real long-term memory, so there is no per-agent memory to port (frank's config: "Notion is the only org memory bank, do not keep a parallel brain in Grok chat memory").
3. **Grok skills** `sand-workflow:org-memory-bank`, `frank-memory-sweeps`, and the CoS routines' bodies were not found. `build-a-project-dashboard` survives in the handoff pack. The CoS said on 22 Sep that its own Grok memory held "co-founder / Operator OS operating conventions (weekly rhythm, RED gates, parallel employee bots, plain-English before fan-out)"; that is all I have of it.
4. **The self-authored soul packs** (frank-ea, projects-manager, eggbot folders written on 24 Sep: SOUL, PHILOSOPHY, SKILLS, OPERATING, README, MEMORY, TOOLS) were at `~/Projects/hermes-soul-pack`, which no longer exists. I searched `~/Projects`, `~/.hermes`, Spotlight, the Trash, and the zips. They were the closest thing to each agent's own voice and are the biggest loss.
5. **Leadership Board 29 Sep to 15 Oct 17:19.** The Sep export ends 28 Sep 17:23 and the live window starts 15 Oct 17:19. Alfred's and Critiquito's arrival, the 14 Oct hub-spec debate and the group side of the 23:25 message are only visible indirectly (PM and CoS 1:1s, the SPEC decision log, the ledger).
6. **Alfred and Critiquito** have the least history (13 and 4 entries in their 1:1s).
7. **Voice.** Voice-call turns appear as empty entries, so some of Ash's rants and some agent replies are missing.

## 4. Things to know before using the drafts
- **Critiquito's add-on text in the hub is wrong.** `builtInMonos.ts` says `ADDON_OFFER = { name: "Critiquito", what: "reviews plans and work before they ship" }`. His real job is design critique of screens. Suggested replacement: "reviews how a screen looks and reads, and ranks the fixes".
- **PM drifted from his config.** The config says he never does the specialist work, yet on 14-15 Oct he built the hub front end in code. The drafted SOUL puts building back with the coding Lead and keeps PM on plan, tickets and review. Ash has not said which he prefers; on 14 Oct he also said he was not sure PM fully understood a brief and credited frank with pulling the team back on track.
- **frank's exec-assistant duties** (calendar, conference rooms, interview prep, "andrew-*" automations) came from someone else's template and were never Ash's life. Marked optional and off.
- **Two Critiquito bots** exist in Grok Bot (16 Sep, 14 Oct); the 14 Oct one is in the room. "Kritiko" in Ash's notes is his dictation of Critiquito.
- **Ash wants plain role names**: in `roleNames.ts`, frank = "Memory and checks", Alfred = "Team setup", Critiquito = "Design review". CoS and PM already read as roles.
- **Em dashes:** Ash does not want them in anything sent as him. I removed them from quotes and kept them out of the drafts.
- **Hygiene:** no secrets went into these drafts; I redacted long tokens in my scratch copies.

## 5. How I adapted Grok-specific things for MonoCode (draft mapping)
| In Grok Bot | In the SOUL drafts |
|---|---|
| CreateAgent / UpdateAgent / SendToAgent / CreateChannel | A Mono asks Alfred and Ash; new Monos need Ash's yes; Leads start subagents (workers) |
| CloudAgent repo work, Mac-local shell | The project Lead's coding chat and its subagents |
| Outcome Register, Teams board, Projects DB in Notion | The hub board (jobs under the Lead), each Mono's own update file; only the Lead changes the main board. Notion is optional and off by default |
| What's true / Proposed memories | Shared harness memory with the same propose/promote gate; each Mono's own MEMORY.md for seat-specific facts |
| Widgets (A/B buttons) | A single clear question with a recommendation and two real options |
| Routines | Automations (weekly/monthly reviews, twice-daily memory skim) only when a data source is reachable |
| Leadership Board, Dept Leads room, Ship Room, Dev Team rooms | One leadership team group chat per project; child chats nested under the Lead for delegated work; Dev Team rooms retired |
| Dept leads, Dev Team Lead/Dev/QA | A project Lead Mono plus short-lived worker subagents (see project-lead-seed.md) |

## 6. Scratch
`../work/` (sibling of this folder) holds my rendered, redacted copies of the transcripts and the scripts. It is not needed for anything. Delete it when you are done.
