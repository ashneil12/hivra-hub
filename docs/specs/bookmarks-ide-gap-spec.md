# Bookmarks IDE gap spec: what Dropwave already has against the ten ideas

Research only, 13 Nov 2026. Nothing here is built. It compares today's code (main at `a32327d6`) with the ten ideas
from Ash's X bookmarks write-up (Capy Captains, the two ADE tier lists, ADEMark, and the open-source repos he
bookmarked), says what is enforced by code and what a prompt only asks for, and ranks the five changes that would cut
babysitting the most for the least work.

Words used here: **Chief of Staff** is the captain Mono (the one carrying `CAPTAIN_CHARTER`). A **first mate** is any
chat with `Session.firstMate` set: every Mono and every coding-team chat. **Crew** or **worker** is a delegated task's
chat. "Present (enforced)" means code refuses or performs it. "Prompt-only" means the model is told and nothing checks.

## 1. What I read

Dropwave (this repo): `src/features/firstmate/` (contract, watcher, model), `src-tauri/src/firstmate/`,
`src/features/chief/`, `src-tauri/src/decisions/`, `src/features/crew/` (digest, inbox), `src/features/needs/`,
`src/features/asks/`, `src/features/monos/model/` (rotation, state card, files), `src/features/memory/model/longChat.ts`,
`src/features/sessions/model/contextUsage.ts`, `src/features/browser/`, `src-tauri/src/browser/`,
`src-tauri/src/pr_watch/`, `src-tauri/src/automations.rs`, `src/features/leadTick/`, `src/app/App.tsx` (turn notes).
The write-up's `vendor/firstmate-contract.md` and `src-tauri/src/delivery/` are at
`src/features/firstmate/vendor/firstmate-contract.md` and `src-tauri/src/delivery/` (delivery is the PR and merge
path, not the first mate contract).

Sources inspected directly, not only from the summary:

| Source | How | What it confirmed or changed |
| --- | --- | --- |
| Capy Captains docs (docs.capy.ai/captains) | page read 13 Nov | Confirmed: digest rewritten on crew state change, Needs you slice pasted into chat with a tag, AGENTS.md vs CREW.md ("every crew thread reads on every turn"), promote / demote / archive, one crew per thread, PR filter by Captain, `captain=<name>` from Slack with alias, automations wake a Captain. |
| Capy 0.7.0 changelog | page read | Confirmed: "Loaded before the first message" context breakdown per part with share of window; "Waiting on you to merge capy#8426" requests stay open until answered, in thread, sidebar and tab. |
| ADEMark (ademark.dev) | results table read | Confirmed the token numbers. New: **upstream MonoCode** (the app Dropwave forks) sits 7th with **9.0% idle CPU**, the second highest after Traycer (15.8%; Zeron 1.7%, super.engineering 0.18%); its real-prompt tax is 122.4K vs 168.3K for the bare CLI. |
| firstmate (kunchenguid/firstmate) | cloned | `/bearings` = four fixed sections (Captain's Call, Recently Landed, Underway, Charted Next) from one deterministic snapshot command, read-only; `/ahoy` = recap since the captain's last real message plus walk through unanswered decisions. |
| fast-jev-compaction | cloned, README and `src/` | Correction: it scores calls with **Jev, a paid TypeSafe model** (`TYPESAFE_API_KEY`), and plugs in through Claude Code's early-access `session.compact` function hook (2.1.274+, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`). The algorithm (pin first and recent messages, two keep questions per call, truncate or drop, never touch text) is MIT and portable to any cheap model. |
| coworkers (fayazara) | cloned README | Adds two things the write-up did not name: **routines that "watch a URL, command or saved script and only wake when it changes"** (idea f), and **"Open items: tracks things it's waiting on until they're resolved"** (idea e). Rules per action: allow, ask first, block. |
| Nanobrowser | cloned README | Ask mode by default: submit, send, delete, upload ask first; pay, password, codes are always handed to the person; per-site Allow / Ask / Block. Own messages kept in full when long chats are summed up. |
| Sandcastle | cloned README | `run()` with OS sandbox (Seatbelt on macOS), Docker, or cloud, plus a branch strategy and merge-back. A library shape for crew runs, not a product to adopt now. |
| security-audit-skill (Cloudflare) | cloned | Six phases with a coverage ledger and two validators (`validate-findings.cjs`, `validate-coverage-ledger.cjs`). Already in the watch list. |
| 0 (0sec-labs) | cloned README | MIT OR Apache-2.0. A security harness with a hosted PR-review service; security lane only. |
| Zeron, Traycer, Emdash, Cezar, Volt, t3-pstack | cloned README and licence | Zeron MIT (Rust GPUI, local-first, headless Linux engine). Traycer MIT. Emdash **Apache-2.0** (confirmed). Cezar MIT and its README lists "a workspace dashboard shows what needs you, what is running and what finished". Volt is an MIT **VS Code fork** with `VOLT-ORCHESTRATOR-PLAN.md` and run-group plans. t3-pstack MIT, works only inside T3. |

## 2. What exists today

### 2.1 The chain: Chief of Staff, first mate, crew

| What | Enforced or prompt | Evidence |
| --- | --- | --- |
| At most two levels below the chat Ash talks to (first mate, first mate, workers) | Enforced | `src-tauri/src/firstmate/mod.rs:43` `MAX_DEPTH`, `:46` `check_depth` |
| At most 8 open tasks per first mate | Enforced | `src-tauri/src/firstmate/mod.rs:63` `check_fanout` |
| Every Mono chat is a first mate | Enforced | `src/features/monos/model/monoMate.ts:23` `stampFirstMate` |
| A first mate never edits the project | Enforced for Claude Code and Codex, checked after the turn for the other CLIs | `src/features/firstmate/model/readOnly.ts:23` (Claude: Edit, Write, MultiEdit, NotebookEdit disallowed), `src-tauri/src/firstmate/checkout_guard.rs`, README table `src/features/firstmate/README.md` |
| A worker never asks Ash directly | Enforced | `src-tauri/src/decisions.rs:539` `check_may_ask` |
| The captain's charter: write every ask down first, hand work to first mates, "never starts crew itself" | **Prompt-only** (the text is locked in the soul, its behaviour is not) | `src/features/chief/model/charter.ts:4` |
| A captain-only handoff tool that files the task, then delegates to the project's first mate | Enforced as a tool; only the captain may call it | `src/features/agent-app/model/agentApp.ts:1903` to `:1906` |
| The captain may not answer owner-only keys, red-list items, money past the limit, or more than 20 turns an hour | Enforced in the decision store | `src-tauri/src/decisions/captain.rs:21` `is_captain`, `:27` `owner_key`, `:58` `refuse_key` |

### 2.2 Telling Ash what needs him

| What | Enforced or prompt | Evidence |
| --- | --- | --- |
| One deduped Needs you list across chats, decisions, checks, merges and reviews; every number on screen counts it | Enforced (plain code) | `src/features/needs/model/needsYou.ts:1` to `:18`, kinds at `:25` (`stopped`, `question`, `approval`, `merge`, `review`, `check`) |
| Each row opens exactly what it names | Enforced | `src/features/home/model/needTarget.ts:6` |
| A one-tap answer only for a safe recommended option, never for red-list or person-only keys | Enforced | `src/features/needs/model/needsYou.ts:255` to `:275` |
| Quiet by default: decisions and questions go out at once, reviews, failures and limits wait for an hourly digest | Enforced, **but only as a banner in the first mate inbox panel**, not in a chat | `src/features/crew/model/digest.ts:68` `planDigest`, `src/features/crew/model/inbox.ts:453` `noticesFrom`, `src/features/crew/ui/FirstMateInboxPanel.tsx:164`, `:289` |
| The ask ledger: Ash's asks extracted on send, a receipt, open asks beside his next message, a nudge (max 2) when a turn ends with asks nobody gave a status | Enforced (code builds the note; the model still decides the status) | `src/features/asks/model/askNotes.ts:1` to `:9`, `src/app/App.tsx:10269` |
| Morning habit: the captain reads tasks, docs and activity and reports only lines that name something it read | Enforced filter on a model's output | `src/features/chief/model/habit.ts`, `src/features/chief/model/summary.ts`, `src/features/chief/model/answer.ts` |
| Lead tick: once a minute per project, plain code reads the programme and CI, merges green when Ash turned that on, starts the next package | Enforced, no model | `src/features/leadTick/model/tick.ts:1` to `:5`, `src/features/leadTick/model/schedule.ts:1` to `:6` |

### 2.3 Waiting, context and memory

| What | Enforced or prompt | Evidence |
| --- | --- | --- |
| Zero-token watcher and durable wake queue: a first mate wakes only on report, question, stall, PR event or its own timer | Enforced | `src/features/firstmate/watcher/README.md`, `src-tauri/src/watcher/queue.rs`, `src-tauri/src/watcher/timers.rs` |
| "Don't poll or sleep. End your turn; the app wakes you" | **Prompt-only** | `src/features/firstmate/contract.md:175` |
| A worker repeating the same finished step 6 times is a loop stall; 20 silent minutes stops it | Enforced | `src/features/firstmate/watcher/stall.ts:39`, `src/features/firstmate/watcher/classifier.ts:30` |
| The contract and soul are sent once per engine session, not every turn | Enforced | `src/features/monos/model/monoFiles.ts:394` `planAgentContext`, `src/app/App.tsx:10328` to `:10339` |
| Live context ring once the engine reports usage | Enforced, after the first reply only | `src/features/sessions/model/contextUsage.ts:1`, `src/features/sessions/ui/ContextMeter.tsx:30` |
| Rotation at 80% of the window: a fresh engine session with the last 2 exchanges word for word and one line per earlier exchange, no model | Enforced | `src/features/monos/model/monoRotation.ts:8` to `:26` |
| Summary tree for long first mate chats (over 16,000 bytes of text) | Enforced | `src/features/memory/model/longChat.ts:4` |
| State card at a fresh session from the ledger and the files touched, no model | Enforced | `src/features/monos/model/stateCard.ts:1` to `:4` |
| Standing notes loaded in full on every handover: `ash-asks`, `finished-work` | Enforced | `src/features/monos/model/monoFiles.ts:74` |

### 2.4 Crew rules, browser, PRs and wake sources

| What | Enforced or prompt | Evidence |
| --- | --- | --- |
| First mate rules (the contract) are separate from worker rules | Enforced split, fixed text | contract: `src/features/firstmate/model/contract.ts:23`; worker rules: `src/features/agent-app/model/agentAppTasks.ts:579` |
| Worker rules travel in the brief, once, at the start | Enforced, **first turn only** | `src/features/agent-app/model/agentAppTasks.ts:589` `briefPrompt`; steering messages do not carry them (`src/features/firstmate/model/steering.ts` has no rules text) |
| Per-Mono crew rules | Routing only (which CLI, model, effort, cost cap), not instructions | `src/features/crew/model/rules.ts` `CrewRule` |
| One browser profile per first mate, shared by its workers | Enforced | `src/features/browser/model/agent.ts:1` to `:3`, `src-tauri/src/browser/mod.rs:1` to `:4` |
| Proof files under a worker's `.e2e/` are collected from its report | Enforced collection, **no gate that UI work must have one** | `src/features/firstmate/model/e2eEvidence.ts:1`, `src-tauri/src/delegations.rs:908`, `:948` |
| A PR watch records which Mono owns it | Data present, **no filter in any screen** | `src-tauri/src/pr_watch/mod.rs:75` (`owner_mono`); `ownerMono` is read only in `src/app/App.tsx` |
| Automations wake on time, GitHub, Linear, Jira, GitLab, Azure DevOps | Enforced list; **no Slack or chat-app trigger** | `src-tauri/src/automations.rs:281` |
| Mono habits on a schedule, in a hidden session, posting only what is worth saying | Enforced | `src/features/monos/model/monoHabits.ts` |

## 3. The ten ideas against today

| # | Idea | Status | One-line reason |
| --- | --- | --- | --- |
| a | Needs you digest pasted into the main chat, with a mention | **Partial** | The list and an hourly digest exist, but they live in Home, the Inbox and a first mate panel banner; nothing posts the slice into the Chief of Staff chat when it changes. |
| b | Lead-only rules vs crew rules reread every turn | **Partial** | The split exists as fixed app text; there is no editable per-first-mate CREW file, and workers see the rules once, not every turn. |
| c | Promote a thread or group into an area Captain, demote later | **Missing** | A Mono is made only by `mono_create` with Ash; no thread or folder becomes a captain and back. |
| d | The Captain is blocked from doing the work | **Partial, mostly present** | File edits are blocked for Claude Code and Codex first mates and checked for the rest; "hand to first mates, never start crew" is prompt-only for the Chief of Staff. |
| e | Persistent waiting-on-you request cards with jump-to and dismiss/undo | **Partial, mostly present** | Rows persist until their source clears and jump to their target; no dismiss with Undo, and the request does not show on the chat's tab or in the chat itself. |
| f | Waiting does not burn quota | **Present for first mates, prompt-only against sleep loops** | The watcher and timers are zero-token; nothing stops a `sleep 60; check` Bash loop, and a changing output escapes the loop detector. |
| g | Pre-flight context breakdown and prompt tax | **Partial** | A live ring after the first reply, and notes are sent once per engine session; no breakdown before the first message and no per-part numbers. |
| h | Compaction by scoring tool calls, text verbatim | **Partial, different method** | Rotation keeps the last 2 exchanges verbatim and lines for the rest, with no model; tool calls are simply dropped, not scored. Claude Code's own compaction still runs on non-first-mate chats. |
| i | Browser crew member in the same digest, prove-in-browser gate for UI | **Partial** | Browser profiles per first mate and `.e2e` proof collection exist; no gate demands proof for UI work, and browser work has no line of its own in the digest. |
| j | Handoff files, PRs filterable by Captain, wake by alias from Slack or a schedule | **Partial** | Reports are typed and stored, `finished-work` is a standing note, PR watches carry their owner, habits and timers exist; no PR filter by owner and no chat-app steering. |

## 4. Each gap: what fails, the smallest change, where it lives, how to prove it

### a. Needs you digest in the main Chief of Staff chat

- **What fails today.** Ash has to open Home or the Inbox to see what needs him. The Chief of Staff chat, where he
  actually talks, never hears that a side thread now needs him unless a model happens to mention it. The hourly digest
  (`digest.ts:68`) only feeds a banner in the first mate panel.
- **Smallest change.** Reuse `planDigest` and the one Needs you list. When the list's set of keys changes, post one app
  note (`[MonoCode needs you]`, same shape as the ask nudge in `askNotes.ts`) into the pinned Chief of Staff chat: the
  new items only, each with its open link, and a mention line when an item is owner-only (`isOwnerKey`,
  `chief/model/captain.ts`). Cap it the way the ask nudge is capped (at most one per change set, quiet hours respected).
  No model call: the note is built from the list.
- **Lives in.** Main Chief of Staff chat (posting), app code (building).
- **Proof.** A unit test on the note builder (new key posts once, same key never twice, cleared key drops on the next
  note). A browser spec: a worker question passed to Ash makes one note appear in the pinned chat with a working link.
  The fake-Claude bench (`hub:verify-live`) shows no extra model turn is spent.

### b. Lead-only rules vs crew rules reread every turn

- **What fails today.** Ash can't say "from now on every worker opens PRs as drafts" to one first mate and have it
  stick. `workerRules` is fixed app text (`agentAppTasks.ts:579`), Mono crew rules only route models, and a worker sees
  its rules once in the brief, so after a long run or an engine compaction the rule can fall out.
- **Smallest change.** A `CREW.md` beside each Mono's `SOUL.md` and `MEMORY.md` (`monoFiles.ts` already jails those),
  capped in size like `STANDING_MAX_BYTES`. `briefPrompt` appends it after `workerRules`; every steering message and every
  watcher wake to a worker carries its hash, and the full text again when the hash changed. The first mate edits it
  only when Ash's own words ask (same rule the memory review uses).
- **Lives in.** First mate (owns the file), worker (reads it).
- **Proof.** Unit test: a rule added mid-run reaches the worker's next steering message. A fake-Claude run where the
  worker's context rotates still shows the rule in the next turn.

### c. Promote a side thread or group into an area Captain, demote later

- **What fails today.** When a side thread grows into a feature with many PRs, Ash keeps steering it by hand or asks
  for a new Mono and re-explains. Nothing moves a thread's history and PRs under a new captain.
- **Smallest change.** A "Make this a first mate" action on a chat: stamp `firstMate` (the same `stampFirstMate`), make a
  Mono through the existing `mono_create` path with Ash's yes, move the chat's open delegations and PR watches to it
  (rows already carry `owner_session` and `owner_mono`), and attach it to the Chief of Staff's project. Demote reverses
  the flag and returns the rows. Keep the depth rule as it is: a promoted area captain is a first mate under the Chief
  of Staff, so it still fits `MAX_DEPTH`.
- **Lives in.** Main Chief of Staff chat (offers it), app code (moves rows).
- **Proof.** Unit test that a promote then demote leaves the same rows and PR watches. Browser spec that the promoted
  chat shows its crew and its PRs. Watch for the one-crew-per-thread rule: a thread already under another first mate
  is refused.

### d. The Captain does not do the work

- **What fails today.** The Chief of Staff can still call `tasks.delegate` straight to a worker and skip the project's
  first mate, because nothing in `agentAppTasks.ts` asks who the caller is. The charter says it must not
  (`charter.ts:4`). On Cursor, Grok, Hermes, Devin, Antigravity, OpenCode and Pi, a first mate's edit is only caught
  after the turn (`readOnly.ts`).
- **Smallest change.** In `tasks.delegate`, refuse a call from the captain's chat with the words "Hand this on with
  captain.handoff", so the only road out of the captain is the handoff tool that already exists (`agentApp.ts:1903`).
  Later, wire the ACP read-only answers the README already lists for Cursor, Grok and Hermes.
- **Lives in.** First mate gate (app code).
- **Proof.** Unit test: a captain `tasks.delegate` is refused; `captain.handoff` still files and delegates. The existing
  checkout-guard tests cover the edit side.

### e. Persistent waiting-on-you request cards

- **What fails today.** The Needs you rows persist and jump correctly, but Ash can't put one away for now and get it
  back, and the chat that is waiting does not say "Waiting on you to merge #372" on its own tab or in its own view.
- **Smallest change.** A Dismiss on a row that hides it until its key changes or 24 hours pass, with an Undo toast
  (Home and Inbox already share the list, so one store). Show the row's sentence as one line at the top of the waiting
  chat and a dot on its tab.
- **Lives in.** Main Chief of Staff chat and Home (screens), app code (store).
- **Proof.** Browser spec: dismiss, Undo, and dismiss then a key change brings it back. Snapshot of the chat line.

### f. Waiting does not burn quota

- **What fails today.** First mates are event-driven, which is the hard part, done. But the rule against polling is a
  prompt line (`contract.md:175`), and the loop detector needs the same call with the same output
  (`stall.ts:39`), so `sleep 60 && gh pr checks` with changing output is not caught. Workers are refused timers
  (`src/features/agent-app/model/agentAppTimers.ts:27`: "Only a first mate's own chat ... sets timers"), so a worker waiting on CI is the likely place this burns quota.
- **Smallest change.** Two pieces. (1) A plain-code check on each finished tool step: a Bash call that is `sleep N` (or
  ends in one) repeated 3 times in a turn becomes a stall with the words "Waiting by sleeping costs tokens; set a timer
  or end your turn". (2) Give workers `timers.set` and the PR watch, the same wake the first mate has, so "check CI
  again" has a free road. Coworkers' "only wake when it changes" routine is the right shape for a later watch on a
  command's output.
- **Lives in.** Worker (tools), app watcher (detection).
- **Proof.** Unit test on the classifier with a fake transcript of three `sleep 60; gh pr checks` steps. A fake-Claude
  run that waits on CI with a timer spends no turns while waiting.

### g. Pre-flight context breakdown and the prompt tax

- **What fails today.** Ash can't see what a new chat will load before he types: the soul, memory block, standing
  notes, contract (about 17.8 KB, roughly 4,500 tokens, `contract.md`), worker rules, the project memory primer,
  standing answers, pstack's skill index (about 3,300 tokens) and each CLI's own system prompt. ADEMark's one useful
  number for us: upstream MonoCode's real-prompt tax is 122.4K against 168.3K for the bare CLI, so the base is not
  bloated; Dropwave adds the parts above on top, and nobody has measured by how much.
- **Smallest change.** A read-only "Loaded before the first message" panel per Mono and per project: build the same
  note `monoTurnNote` would build, split by part, estimate tokens by characters (the estimator fast-jev uses is fine),
  and show each part's share of the model's window. No new data, just the existing builders run dry.
- **Lives in.** Settings and the Mono overview (screen); app code (dry run).
- **Proof.** Unit test that the parts add up to the real note byte for byte. Then one ADEMark-style measurement of
  Dropwave itself (hello prompt and the real prompt) recorded in `docs/hivra/memory-eval.md`.
- **Also worth a look.** ADEMark's 9.0% idle CPU for upstream MonoCode is high next to Zeron (1.7%) and
  super.engineering (0.18%). Dropwave adds a once-a-minute lead tick, the watcher look and the PR watch on top. A
  one-off idle profile on Ash's Mac would say whether that is ours to fix.

### h. Compaction that scores tool calls and keeps text verbatim

- **What fails today.** For first mates the risk the idea guards against is mostly handled: rotation keeps text, the
  ask ledger keeps Ash's asks outside the chat, the state card lists files touched. The gap is the middle: earlier
  exchanges become one 280-character line each (`monoRotation.ts`), and every tool result is gone, including one that
  still matters (an exact error, a path). Workers and plain chats still use Claude Code's own summary when they fill up.
- **Smallest change.** Port fast-jev's algorithm (MIT), not its service: when rotating, score the closing stretch's tool
  calls with the cheap model the app already uses for memory (`memory/model/cheapAsk.ts`) and keep the top few results
  word for word in the rotation brief, under a fixed byte cap. For workers on Claude Code, test fast-jev's
  `session.compact` hook later, once function hooks leave early access, with Jev swapped for the same cheap model.
- **Lives in.** First mate (rotation brief); worker later.
- **Proof.** The long-chat test bed (`src/features/asks/testbed/longChat.test.ts`) gains a case where an exact error
  from 40 turns back must survive rotation. Measure brief size before and after.

### i. Browser crew member and a prove-in-the-browser gate

- **What fails today.** A worker can change a screen and report done with no screenshot; the `.e2e` evidence is
  collected only if the worker chose to make it. Browser jobs are just worker jobs, so "the browser is signed in and
  waiting for you" looks like any other question.
- **Smallest change.** A brief flag `ui: true` (set by the first mate, or by a changed path under `src/**/ui/` or
  `*.tsx`) makes the done gate require at least one `.e2e/*.png` from this run, the same way a code brief in `full` mode
  requires a check line (`briefChecks.ts` `checksRefusal`). Hand-over-the-browser for a login (Coworkers' "I'm done",
  Nanobrowser's pay and password steps) becomes a Needs you kind of its own.
- **Lives in.** First mate gate (refusal), browser crew (proof), Needs you (hand-over row).
- **Proof.** Unit test: a UI brief without proof is held, with proof passes. Browser spec on the hand-over row.

### j. Handoff files, PRs by Captain, wake by alias

- **What fails today.** Reports exist but live on delegation rows, not in a place a new first mate session browses.
  PRs can't be listed by which first mate owns them, though the data is there (`pr_watch/mod.rs:75`). Ash can't steer
  a named first mate from his phone or a chat app except through the app itself.
- **Smallest change.** (1) A "By first mate" filter on Being built, reading `owner_mono`. (2) Write each settled
  report to the Mono's folder as `reports/<date>-<task>.md` (beside `finished-work`), so a fresh session can list them.
  (3) Leave Slack for later: phone access (`mobile_access.rs`) is the road Ash already has. If he wants Slack, it is a
  new automation trigger kind in `automations.rs:281` that routes to a Mono by name.
- **Lives in.** Screens (filter), first mate (reports), automations (later).
- **Proof.** Browser spec for the filter; unit test that a settled report writes once.

## 5. The five changes that cut babysitting most for least cost, in order

1. **Post the Needs you slice into the pinned Chief of Staff chat (idea a).** The data, the dedupe and the quiet-hour
   rules all exist; the change is one note builder and one post. It is exactly the roll-up Ash keeps asking for, and it
   means he never has to open a side thread to find out it is waiting on him.
2. **Make `captain.handoff` the captain's only road to crew (idea d).** A few lines in `tasks.delegate`. It turns the
   charter's "never starts crew itself" from a hope into a rule, so work always lands with a first mate that watches it.
3. **Catch sleep-and-poll and give workers timers (idea f).** A classifier rule plus exposing a tool that already
   exists. It stops the one failure in the bookmarks that costs real money (a 5-hour limit burned by "sleep 60s, check
   again") without changing how anyone works.
4. **A per-first-mate CREW file, re-sent on change (idea b).** One more file in a folder that already holds two, one
   more part in the brief, and a hash on steering. Ash says a rule once and every worker under that first mate keeps it.
5. **Dismiss with Undo on Needs you, and the waiting line on the chat (idea e).** Small screen work on a list that is
   already right; it is what makes the list something Ash can clear, rather than a pile.

Next after these, by value: the pre-flight context panel (g), the UI proof gate (i), the PR filter by first mate (j),
promote and demote (c, the biggest of the ten), and tool-call scoring at rotation (h).

## 6. Open questions for Ash

1. **Where does the roll-up post?** Into the pinned Chief of Staff chat as an app note (recommended), or only as a bar
   above that chat that never enters the transcript?
2. **How loud?** Every change at once, or Needs you at once and everything else in the hourly digest, as the first mate
   panel does today?
3. **Should the Chief of Staff be hard-blocked from starting workers itself**, even for a one-line fix? Recommended yes:
   it hands on through the project's first mate.
4. **CREW file scope:** one per first mate (Capy's shape), or one per project that every first mate's workers read?
5. **Promote and demote:** is a side thread turning into its own first mate something you want soon, or is one Chief
   of Staff plus a first mate per project enough for now?
6. **UI proof gate:** should a UI change without a screenshot be refused outright, or marked "Not shown in the browser"
   and allowed through, like "Built, not tested yet"?
7. **Slack or another chat app:** do you want to steer first mates from Slack, Telegram or WhatsApp, or is the phone app
   the only remote road?
8. **Compaction:** is it worth paying a cheap model at each rotation to keep the right tool results, or keep rotation
   model-free as it is today?
9. **Idle CPU:** should someone profile Dropwave at rest on your Mac, given upstream MonoCode measured 9% idle CPU on
   ADEMark?

## 7. Notes on the sources

- Licences checked from each repo's own file on 13 Nov 2026: Sandcastle, coworkers, fast-jev-compaction, t3-pstack,
  Zeron, Traycer, Cezar, Volt, security-audit-skill MIT; Nanobrowser and Emdash Apache-2.0; 0 is MIT or Apache-2.0;
  Timon AGPL-3.0 (ideas only, never vendor).
- All of these are now in `docs/hivra/upstream-watch.json` (group `finds-2026-11-13`, Timon under `idea-only`).
  security-audit-skill, Traycer and Emdash were already there. Herdr, agent-beacon and Agenta, also in the write-up's
  inventory, were added too.
- Closed or unconfirmed tools (Capy, bb, super.engineering, Synara, Maestri, Podium, Diri, Aside) are ideas only.
- Nothing in this spec is built. Each item above goes on the list until Ash picks.
