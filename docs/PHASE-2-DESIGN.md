# Phase 2 design: the chat owns its asks, durable delegation, the checker

Written 19 Oct 2026 by a read-only design pass over hub/next (8bf13e52) and the studio (main 4b99eb0). Ash's words and docs/HUB-PLAN.md win over it.

I've designed the Phase 2 plan below and changed nothing. The two biggest findings: the sweep is already saving the hub's own prompts as Ash's words, and MCP servers don't inherit the chat's environment, so the app token must be passed in explicitly.

Hub line numbers are from `/Users/ash/Worktrees/monocode-hub-next` (hub/next @8bf13e52). Studio line numbers are from `/Users/ash/Projects/exo-cc-studio` main @4b99eb0.

**Before starting:**
- Phase 1 must be merged.
- Dev slots and the fake-Claude bench (T3 items 12, 11, 17) are the gate for H2–H4.
- One person should build H2 and restart-safe resume (item 16), as the harvest says.

## Decisions

1. **Delegation records live in the hub; the studio keeps a copy.**
   - Boot recovery, cascade Stop and `task_wait` must work while the studio restarts. Only the hub knows sessions and turns ("the app is the runtime and Ash OS is the record", from the `ashos/hub.py` docstring).
   - The studio gets a versioned copy (`hub_delegations`) for Being built, the brief and the checker. It never writes back.
   - Every monitored `sessions.start`/`sessions.send` from a Mono also writes a row, so the plain CLI and `delegate_task` share one durable path.

2. **How an ask gets its owner.** Owner is `mono:<id>`, `chat:<hub session>` or `claude:<Claude session>`.
   - **Hub chats:** every Claude session's ash-os entry carries `ASH_MONO_ID`, `ASH_ROLE` and a new `ASH_CHAT`. Today only Leads get an identity (`hubLeads.ts:97`).
   - **Chats outside the hub:** they have no MCP identity, because Claude Code passes MCP servers only HOME, LOGNAME, PATH, SHELL and USER (`hubLeads.ts:95`).
     - The ash-os skill passes `session: ${CLAUDE_SESSION_ID}`. The 2.1.302 binary appears to substitute this in skill text; confirm with one chat.
     - That is the same id the sweep stores in `dumps.session`.
   - **Dumps nobody recorded:** these resolve through `hub_chats` (Claude session → hub chat). The hub writes it on every providerBound, so Mono rotation keeps working.

3. **Delegate tool identity = the app token.**
   - A `monocode mcp` stdio subcommand sits next to `app` (`main.rs:12`) and maps tools to new `tasks.*` actions.
   - `control.rs` maps token → session, so a model can never name another chat.
   - Since MCP servers don't inherit the environment, the one `--mcp-config` entry sets `MONOCODE_APP_ENDPOINT` and `MONOCODE_APP_TOKEN` to `"${…}"`. Claude Code expands `${VAR}` in MCP configs; confirm it does for `--mcp-config` in a dev slot.
   - Fallback: a 0600 token file per session, passed by path only (the studio already does this with `use_token_file`). The token never goes in argv.
   - Only Monos get the tool, and calls work only inside the caller's active turn (`control.rs:161`).

4. **How the checker reaches the owner privately.**
   - The checker writes findings to the studio.
   - The hub pulls undelivered checks (on feed topic `checks` and at boot) and queues a `[MonoCode check]` turn in the owner's chat.
     - That turn waits for the chat to be idle and never interrupts.
     - It shows as a quiet card, never on Today.
   - The owner answers with `ash_record {check}`.
   - **Owner outside the hub:** the check comes back on that chat's next ash-os call carrying its session.
     - After 12 hours with no answer, it becomes one quiet Needs row: "Hand to \<Lead\>" (Ash's tap moves ownership) or "Leave it".

5. **What Being built shows once the runner feeds are gone.**
   - One job per owned ask in working or review: the owner's own work plus its delegations. A delegation with no asks gets one job for its top level.
   - Jobs sit under the owning Mono and workers are never named. The second line is the real stuck reason, "working toward: …", or counts.
   - The runner and studio feeds stay inert until the cut.
   - Moving each project to the in-app Lead (`flip_work_owner`) needs Ash's go.

## 1. Data model and tools

**Hub table `delegations`**
- Lives in new `/Users/ash/Worktrees/monocode-hub-next/src-tauri/src/delegations.rs`, created by its own `ensure_tables` hooked at `session_store.rs:1009`. No numbered migration, so upstream version numbers can't collide.
- Fields:
  - who and where: `id` (taskId), `owner_session`, `owner_mono`, `batch_id` (the owner's turn), `parent_id`, `root_id`, `child_session` (`app-<owner>-<requestId>`), `request_id`, `generation`
  - the work: `project`, `title`, `brief`, `goal`, `ask_ids`
  - state: `state` (running, question, completed, failed, cancelled), `error_class`, `error`, `retryable`, `resets_at`, `result` (≤12k), `pending_question`
  - delivery: `delivery` (pending, queued, delivered, acknowledged, disposed)
  - bookkeeping: timestamps, `log` (up to 50 entries stamped with who acted), `version`, `mirrored_version`
- UNIQUE(`owner_session`, `request_id`).

**Studio ledger** (column changes in `ledger.py`; new tables in `hub.py` SCHEMA)
- `asks` gains `owner` and `owner_at`. `ask.created`/`ask.updated` events gain `by`, which covers "who changed each status".
- `dumps` gains `owner`, `confirmed_at` (the sweep saw it in a human transcript) and `checked_at`.
- `hub_chats(provider_session PK, chat_id, mono_id, role, delegation_id, bound_at)`.
- `hub_delegations`: the copy, with result capped at 2k; a write only lands if its version is newer.
- `checks(id, dump_id, owner, ask_ids, finding, signature, status, delivered_at, answer, answered_at, answered_by)`.
  - `status` is open, delivered, right, fixed or escalated.
  - UNIQUE(`dump_id`, `signature`).

**Studio tools (ash-os MCP)**
- `ash_record {dump_id | text, session?, asks:[{title, quote, kind?, project?, detail?, status?}], none?, check?:{id, verdict: right|fixed, note}}`
  - Returns `{dump_id, owner, asks, repeats, check}`.
  - Every quote must appear in the dump (`core.quote_in`).
  - Refused for workers, and for a dump another chat owns ("owned by Hivra lead").
  - Passing `text` finds the swept dump by hash, or makes a provisional one that only counts as Ash's once the sweep confirms it.
- `ash_update_ask` (existing) gains an owner check and `by`. Marking an ask delegated happens automatically via `delegate_task {asks}`, so there is no second update tool.
- **Checker only:**
  - `ash_checker_queue {hours=48, limit=15}` returns suspect dumps with their text (≤4k), asks, evidence and delegation states. Suspects are picked by fixed rules, not a model:
    - no asks after 30 minutes
    - an open ask idle for 6 hours with no delegation
    - a failed delegation with no follow-up in 2 hours
    - done without evidence
  - `ash_checker_note {dump_id, ok | finding, ask_ids?}`.
- **App-only actions:** `ash-hub-chat-bind`, `ash-hub-delegation`, `ash-hub-checks`, `ash-hub-check-delivered`, `ash-hub-ask-owner`.

**Hub `monocode` MCP tools** (each maps to a `tasks.*` app action)
- `delegate_task {brief, title?, asks?, goal?, project?, model?, effort?, isolation: shared|worktree, mode: async|wait, timeoutMinutes=10, clientRequestId?}`
  - Returns `{taskId, childSessionId, status, result?, errorClass?, hasPendingQuestion, waitTimedOut}`.
  - The brief opens with `[MonoCode brief from <owner>]`.
- `task_status {taskIds?}` returns status, activity, lastActiveAt, result, errorClass, resetsAt, pendingQuestion and child counts. A result returned inside a turn (here or from `delegate_task` in wait mode) counts as acknowledged.
- `task_wait {taskIds?, timeoutMinutes≤60}` returns status only.
  - It loops 25-second app calls, because `control.rs:266` caps a single call at 35 seconds.
  - It returns early when a task finishes or asks a question.
- `task_cancel {taskId, reason?}` stops the whole tree below it and drops reports still owed. Returns `{status, stopFailed[]}`.
- `task_answer {taskId, requestId, answers|skip}`: the first answer wins and is logged on the row.
- **Report-back** keeps MonoCode's one-turn-per-batch shape, prefixed `[MonoCode report]`, with receipt `mono-completion-<requestId>-g<generation>`.

## 2. Work packages

- **Studio:**
  - Each package is a worktree branch `ash-os-<topic>`.
  - It must pass `python3 -m unittest discover -s tests` and `ash selftest --big 120`, then land with `ash land-main` (the lander is paused).
- **Hub:**
  - Branches start from hub/next.
  - Each must pass `hub:check`, `cargo test --lib` and vitest, then be checked in a dev slot: the fake-Claude bench first, then one real run.

**S1 `ash-os-ask-owner` — must land first**
- `/Users/ash/Projects/exo-cc-studio/ashos/ledger.py`: new columns and `by`. A dedupe hit from a human transcript backfills the dump's session and `confirmed_at` (around :152).
- `/Users/ash/Projects/exo-cc-studio/ashos/sweep.py`:
  - `clean():84` strips `<monocode_context>…</monocode_context>`.
  - `MACHINE_MESSAGE:37` adds `\[MonoCode `, `MonoCode completion notification`, and an exact match for "Continue from where you left off."
  - `AUTOMATED_SESSION:24` adds `\[MonoCode brief`.
- `ashos/core.py`: new `record()`, plus the owner check in `update_ask`.
- `ashos/hub.py`: add `checker` to `ROLES:69`; `clean_caller:1639` keeps `chat`; update the app-only and worker-blocked lists; add the three tables.
- `studio/client.py` reads `ASH_CHAT`. `studio/mcp.py` adds `ash_record` and hides it from workers. `studio/service.py` dispatches it.
- `skills/ash-os` and `skills/dump-triage` tell chats to record with `ash_record`.
- Tests: `tests/test_ask_owner.py`, and `tests/test_sweep_machine_text.py` using three real 16 Oct dumps as fixtures (d_1016388f6a, d_10169f8547, d_1016ce27b5).
- Verify: record a 3-ask message from a plain Claude Code chat. Check owner `claude:<sid>`, a second chat is refused, and a hub auto-continue isn't captured.

**S2 `ash-os-delegation-mirror` — after S1, alongside S3**
- `hub.py`:
  - `delegation` action: versioned write, ask-owner check, linked asks move to working.
  - `ask-owner` action: the "Hand to" tap.
- `/Users/ash/Projects/exo-cc-studio/ashos/job_sources.py`: new `delegation_observations`, plus one tuple in `jobs.py` `sync:687`.
- Tests: `tests/test_delegation_mirror.py` (out-of-order versions, foreign asks refused, failed → stuck with the real reason, ask done → job done, no worker names).
- Verify: Being built shows "EXO lead · …" with a count or reason. Then flip the four projects to in-app with Ash's go.

**S3 `ash-os-checker` — after S1, alongside S2**
- New `/Users/ash/Projects/exo-cc-studio/ashos/checker.py`: suspects, notes, and the 12-hour escalation through `collect_needs:1041`.
- `hub.py`:
  - `checks` and `check-delivered` actions
  - the `check.` event mapped to topic `checks`
  - the checker lane: read-only actions plus its two own
- `mcp.py`: the two checker tools, offered only to the checker role.
- Tests: `tests/test_checker.py` (one open check per dump, dedupe by signature, goes quiet after two "right" answers, every write refused).
- Verify: record 2 of 3 asks, the checker notes it, the owner's answer closes the check.

**H1 `hub/honest-results` — can run alongside everything**
- New `/Users/ash/Worktrees/monocode-hub-next/src/integrations/harness/providers/claude/claudeFailure.ts`. It sorts is_error, api_error_status, terminal_reason and the gateway-503 text into usage_limit, billing, auth, overloaded or provider_error, with retryable and resetAt.
- Called from `claudeProtocol.ts:480`, which today marks every `success` result completed.
- `errorClass` added to ControlOutcome (`orchestration.ts:40`) and to the completion result.
- An `api_retry` message becomes a `provider.retry` event and an "API retry 4 of 10" line.
- Tests: T3's `claude_result_is_error` fixture (keep the MIT notice), plus 402, 401, 529 and 503 cases.
- Verify: a worker routed to a bad key is reported "failed: billing refused".

**H2 `hub/delegation-store` — first hub package**
- `delegations.rs` commands: record, settle (atomic, only from running or question), set_delivery, set_question, list_open and tree.
  - An outbox thread sends `ash-hub-delegation` and `ash-hub-chat-bind` via `hub::call_blocking`.
  - Register in `lib.rs`.
- New `/Users/ash/Worktrees/monocode-hub-next/src/features/monos/model/delegations.ts` and `useDelegations.ts`, with one call next to `App.tsx:8969`.
- Behaviour:
  - Rows are recorded in the host start and send paths (:11326, :11446) and settled when the child goes from busy to idle.
  - **Boot:** a finished but undelivered row is queued once; one still running waits; a missing child becomes cancelled.
  - **Resumed turns** (:9602, :9650, :10532) re-attach by session and bump the generation.
  - The completion text (`monoSessionCompletion.ts:114`) gets the prefix.
- Tests: port the four cases from T3's `DelegatedCompletionDelivery.test.ts`.
- Verify: the EXO lead starts 2 sessions; quit the app mid-run; after relaunch exactly one report arrives.

**H3 `hub/delegate-tool` — after H2**
- New `/Users/ash/Worktrees/monocode-hub-next/src/features/agent-app/model/agentAppTasks.ts`, plus FIELDS entries and one dispatch line in `agentApp.ts`.
- Add `APP_ACTIONS` in `control_cli.rs:85`.
- New `/Users/ash/Worktrees/monocode-hub-next/src-tauri/src/mcp_server.rs`, plus the `main.rs` branch.
- `hubData.ts:48` builds one `--mcp-config`:
  - ash-os with an identity for every hub chat; habit runs resolve to their Mono, workers get `worker`, the checker gets `checker`
  - monocode for Monos only, with `timeout: 3900000` and `--allowedTools mcp__monocode__*`
- A seam in `monoFiles.ts:333` adds `<delegate_rules>`: record, delegate with asks, end the turn, review the report, then `ash_update_ask` done with evidence. These go in context, not SOULs, because SOULs are seeded once.
- Verify: a wait-mode task started from the EXO lead returns its result, and Being built shows the job.
- **Built (20 Oct, branch `hub/2-delegate-tool`):**
  - `monocode mcp` (`src-tauri/src/mcp_server.rs`): delegate_task, task_status, task_wait, task_cancel, task_answer, each one or more `tasks.*` app calls; waits are app calls of at most 25 s up to the wait's budget (≤60 min), with progress notifications and cancellation. An unexpanded `${VAR}` counts as no connection.
  - `tasks.*` (`agentAppTasks.ts`, App's host in `monos/model/delegationTasks.ts`): Mono's own chat only (habit runs, workers, plain chats and the checker are refused); a chat only ever sees its own rows (`delegations_owned`); delegate = sessions.start with a brief opening `[MonoCode brief from <Mono>]` and `Done when: <goal>`, always monitored, the row carrying title, ask ids, goal and the hub project id; a result read in `tasks.status` (or a wait-mode delegate) is acknowledged and its report turn dropped. `tasks.answer` checks own row, open question and requestId, and logs who answered; H4 adds the wake.
  - `hubMcp.ts`: one `--mcp-config` per hub chat as above; `${VAR}` expansion and same-name replacement checked with Claude Code 2.1.302, so the token-file fallback isn't needed. A dev copy keeps only this app's own `monocode` entry.
  - `<delegate_rules>` in the Mono context when its Claude Code session has the tool (`MONO_PROMPT_VERSION` 20).
  - Proof: the real Claude Code 2.1.302 ran the EXO lead's turns in a dev copy (temporary HOME, fake model API, stub hub): async and wait delegations made worker chats `app-<lead>-<request>` with rows; the async one reported back once, the wait one returned its result in the turn and was acknowledged (no report); a retried clientRequestId started nothing new; Ash OS's stand-in received each copy with `project: vg-game`.
  - Not done here: Being built showing the job needs S2 in the studio; workers inherit the Mono's permission mode (H4 decides full access); the checker's Mono id is `checker` (H6 makes it).

**H4 `hub/questions-and-tree` — after H3, alongside H5**
- `tasks.answer` works on own rows only, for questions only.
- A worker's question wakes its owner (`question-<child>-<requestId>`). It is skipped while the owner sits in `task_wait` and withdrawn once answered.
- New `monos/model/stopTree.ts`, wired to Stop on Mono chats, `sessions.stop {cascade}` and `task_cancel`.
- New `monos/ui/DelegationBatchRow.tsx` in `LaunchedSessionCard.tsx` ("Delegated 3: 2 working, 1 failed"), plus "Waiting on N".
- Labels for the new tools in `monocodeToolCall.ts:9`.
- Verify: a worker's question wakes the Lead; one Stop halts the worker and its children, and no report follows.
- **Built (20 Oct, branch `hub/2-tree`):**
  - **Questions go to the Lead** (`monos/model/delegationQuestions.ts`, wired by `monos/hooks/useDelegationTree.ts`): when a worker of a Mono-owned row asks (AskUserQuestion), its row moves to `question` (one-line summary; log `asked` by `worker:<child>` with the request id) and the Mono gets a hidden `[MonoCode question]` turn, receipt `question-<child>-<requestId>`, carried as a `monoSessionCompletion` with `question: true` so it waits for an idle Mono and never steers. Not while that Mono sits in `task_wait` (`TaskWaits`, a 3 s linger covers the gap between 25 s slices); the wait returns `hasPendingQuestion` instead, and a skipped wake still goes out if the turn ends unanswered. Withdrawn as soon as the question is gone. `task_answer`: first answer wins (the worker's own `requestId` check plus the harness answering once), and the row's log says who and what (`answered` by `owner:<chat>` with `answers`/`skipped`; Ash in the worker's chat logs `chat:<child>`). `delegations_set_question` takes that `detail` (`set_question_with`). Approvals are never routed. Escalation follows the questions-in-chat package: the Lead asks Ash in its own chat with its pick, then answers the worker. **Merge seam:** that package's `setWorkerQuestionRouter` (Today's "Waiting on you") must get `delegationTree.questions.routes` in App.tsx when the two land together; until then a worker's question also shows on Today.
  - **Worker permission mode:** `tasks.delegate` starts every worker in `full-access` (`WORKER_RUNTIME_MODE`, Claude Code `--permission-mode bypassPermissions`), so no approval prompt strands a worker nobody watches. Checked with Claude Code 2.1.302: in that mode AskUserQuestion still comes to the app as `can_use_tool` (so questions are still routed), and a PreToolUse hook's deny still blocks the tool, so Ash's red-line guards in his Claude settings keep applying (MonoCode doesn't disable hooks for interactive sessions). Plain `sessions.start` keeps inheriting the caller's mode.
  - **One Stop for the tree** (`monos/model/stopTree.ts`): the stopped chat's own turn first, then each row it owns depth first: the row is cancelled (keeps its reason), its worker stopped (15 s cap), its report and question wake dropped, then the rows that worker owns for that job (`parent_id`). Only rows owned by a chat the Stop reached; a delivered report stays. `stopFailed` lists what wouldn't stop. Exposed as Ash's Stop on any Mono with work out (composer Stop, Escape, the floating chat, "Stop all" on the Waiting line), `sessions.stop {"cascade":true}`, `task_cancel` (returns `cancelledBeneath` and `stopFailed`) and the per-row Stop in a Lead's batch.
  - **UI:** `monos/ui/DelegationBatchRow.tsx` in the Lead's chat ("Delegated 3: 2 working, 1 failed", Stop per running row, clickable chips); "Waiting on N" with Stop all above a Mono's composer (`DelegationNotices.tsx`; the rail's tooltip says the same); a worker's chat shows "Runs on its own · Open <Lead>" in place of the composer, with Jump in; the Monos sidebar nests each Mono's child chats (open, owed, or finished in the last 6 hours, oldest first, at most 6) and opens them under the Mono; `monocodeToolCall.ts` names the delegate tools with T3's verb table ("Delegated 2 tasks", "Tried to stop a task" for an error returned as data). Rows reach the UI through `delegations_recent` and `monos/model/delegationStore.ts`. Being built is unchanged: counts only, from Ash OS's copy (HANDOFF Unit 7).
  - `<delegate_rules>` now say how a worker's question arrives and that `task_cancel` stops the tree; `MONO_PROMPT_VERSION` 21.

**H5 `hub/goal` — after H3**
- First confirm in a dev slot that `/goal` works in stream-json mode. If it doesn't, put the goal in the brief as "Done when: …" and show only the Being built line.
- `claude.ts` emits `goal.updated`; `delegate_task` sends `/goal <condition>` before the brief.
- Re-issue after rotation and resume; cap at 20 checks.

**H6 `hub/checker` — after S3 and H2**
- New `hub/model/hubChecker.ts`: a Haiku Mono with an hourly habit.
- An allowlist line in `agentApp.ts`: the checker and its habit runs get only models.list, memory and soul.read.
- `hubStore.ts:630` delivers checks to owners and calls `check-delivered`.
- Verify: an unrecorded ask gets a Checker card in its owner's chat within the hour, and no sessions or delegations start.
- **Built (20 Oct, branch `hub/2-checker`):**
  - `hub/model/hubChecker.ts`: the Checker Mono (`checker`, Claude Code on Haiku; `Mono.model` starts its chat there), a seeded soul (precise, never starts work, never nags) and an hourly habit (`ash_checker_queue`, one `ash_checker_note` per message, always quiet), made by `app/hooks/useHubChecks.ts`, which also opens its chat so the habit runs.
  - Can't start work, three ways, each tested in `hubChecker.test.ts`: the lane (`agentApp.ts` `CHECKER_ACTIONS`, every other app action refused for its chat and habit runs), the tool list (`hubMcp.ts` `checkerToolArgs`: ash-os role `checker`, no `monocode`, `--tools Bash,Read,Grep,Glob`, a deny list with Agent/Task/Edit/Write/NotebookEdit and `Bash(ash:*)`/`Bash(claude:*)`), no delegation (tasks.* refused; `<checker_rules>` replaces the session and delegate rules in its context).
  - Delivery (`hub/model/hubChecks.ts`, `hubStore.ts` `loadChecks`/`onChecks`/`checksDelivered`): pulled at boot and on topic `checks`; one internal `[MonoCode check]` turn (`Block.monoCheck`, receipt `mono-check-<id>`) per check, only into an idle chat with nothing queued, one per chat at a time; then `ash-hub-check-delivered`. Shown as a quiet collapsed card (`hub/ui/CheckTurnCard.tsx`), no unread count or notification, not on Today. Owners get `<check_rules>` with the delegate rules (`MONO_PROMPT_VERSION` 22). A chat outside the hub has nothing to deliver here.
  - Proof: real Claude Code 2.1.302 with the app's own arguments and prompts, the fake model API and the stub (`scripts/hub-stub-checks.mjs`) with the dev ash-os stand-in (`scripts/hub-stub-ash-os-mcp.mjs`, opt-in for a dev copy through `VITE_MONOCODE_DEV_ASH_OS`): the checker's habit run saw only Bash, Glob, Grep, Read and its three ash-os tools, its `ash brief` was denied under full access, its note opened a check that the store pulled and delivered to the idle EXO lead, whose `ash_record` answered it right. A screenshot of the card in a dev copy's window is still owed: the screen was locked during the run, so WebKit never drew the page.

**Order:** S1, H1 and H2 can start in parallel. Then S2, S3 and H3. Then H4 and H5. H6 comes last.

## 3. The T3 items

- **Delegations that survive restarts → H2.** The row is the truth and the in-memory batches become a cache. Boot recovery follows T3's `Orchestrator.ts:11524` and the delivery states at `orchestrationV2.ts:450`; a status read acknowledges, as in `tools.ts:79`.
- **Workers ask their Lead → H4.** The wake wording follows `DelegatedTaskQuestionReactor.ts`. Approvals are never routed, and workers start in full access.
- **Delegation tree and cascade Stop → H2 (parent/root) and H4 (`stopTree`, UI).** Based on `ThreadManagementService.ts:1093` and `agentSpawnSummary.ts`. Being built gets counts only (HANDOFF Unit 7).
- **Honest results → H1.** The error class flows into the report, the row, the studio copy and the Being built reason. 401 and 402 are never retried automatically.
- **/goal → H5,** shown in Being built through S2.

## 4. Risks

- **Machine text saved as Ash's words.** Three hub auto-continue prompts ("Continue from where you left off.") were already saved as Ash's dumps on 16 Oct. Mono turns also start with a `<monocode_context>` block, and reports, pings and briefs would feed the checker its own output. S1 must land first.
- **Token plumbing.** If `${VAR}` isn't expanded, every delegate call fails. Check it in a dev slot first; the token-file fallback is ready.
- **Claude Code's 60-second MCP timeout.** Set `timeout` (or `MCP_TOOL_TIMEOUT`) on the server entry and keep the 25-second slices.
- **Duplicate or lost reports.** Prevented by receipts with generations, the atomic settle, and the four ported T3 cases.
- **Hub and studio drifting apart.** The hub is the truth; the copy is versioned and replayed from the outbox at boot.
- **Ownership too strict.** A refusal names the owner, and Ash's "Hand to" tap is the only way to transfer.
- **Checker cost and nagging.** Suspects come from fixed rules and Haiku sees only those. Limits: one open check per dump, silence after two "right" answers, a daily cap per owner. Dumps from before the switch-over are ignored.
- **Checker starting work.** It is blocked three ways (app allowlist, studio lane, no delegate tool), each with a test.
- **Upstream merges.** Keep to new files plus one hook each, and own-module tables instead of migration numbers.
- **Cascade Stop reaching too far.** It touches only rows owned by the stopped chat and stops children after the parent.

### Critical Files for Implementation
- /Users/ash/Worktrees/monocode-hub-next/src/app/App.tsx
- /Users/ash/Worktrees/monocode-hub-next/src/features/agent-app/model/agentApp.ts
- /Users/ash/Worktrees/monocode-hub-next/src-tauri/src/control.rs
- /Users/ash/Projects/exo-cc-studio/ashos/hub.py
- /Users/ash/Projects/exo-cc-studio/ashos/sweep.py
