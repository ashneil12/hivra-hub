# What we take from T3 Code (19 Oct 2026)

A read-only sweep of T3 Code (github.com/pingdotgg/t3code at 2532e640, MIT), ranked against the hub plan
(`docs/HUB-PLAN.md`). T3 paths are relative to a t3code clone at that commit; hub paths are relative to this
repo as of the plan branch. We take designs, not T3's code: each one is re-implemented on MonoCode's own pieces.

## Take

### Delegations that survive restarts (owed reports stored, recovered at boot)

Phase 2, size M.

**What Ash gets.** Every delegation becomes a stored record. If the Hub restarts, crashes, is reinstalled from inside itself, or a worker resumes after a usage limit, the Lead (or Chief of Staff) still gets exactly one report. Reading a result marks it received and Stop cancels what is still owed. The delegating chat can also see each child's state, current activity and last-active time.

**Why.** Verified: owed reports exist only in memory. MonoSessionCompletionBatches is a Map held in a React ref (src/app/App.tsx:8586, class at src/features/monos/model/monoSessionCompletion.ts:134). Resumed turns are submitted with no monitor (App.tsx:9122, 9170, 9993 call onSubmit(id, CONTINUE_PROMPT)). After any restart a worker finishes silently and the work looks lost. Double delegation and autopilot only work unattended if report-backs are durable. This is the part of T3's wake-parent design that gets dropped when only the four tools are ported.

**How.** Re-implement on the Phase 2 ledger's delegation record: {taskId, owner Mono/session, childSessionId, requestId, brief, goal, startedAt, deliveryState pending|delivered|acknowledged|disposed, result}. Drive it from the existing release -> queueMonoSessionCompletion path and key everything on receipt ids (mono-completion-<requestId> already dedupes). At boot, next to the auto-continue effect: a finished child that was never delivered is enqueued once; a child still in flight gets its monitor back, and delivery waits until its auto-continue has run; a child that is gone is reported as cancelled. Resumed turns (limit resume, auto-continue, later sessions.send) re-attach to the same row. task_status reading a finished result acknowledges it, and Stop disposes it. Add state, activity, lastActiveAt and pendingQuestion to sessions.list via launchedSessionState (monoSpawnedSessions.ts:190). Keep the in-memory batches as a cache. Put the logic in new model files plus one hook. T3 to learn from: apps/server/src/orchestration-v2/Orchestrator.ts:11524-11660 (recoverDelegatedTasks), packages/contracts/src/orchestrationV2.ts:450-480 (delivery states), apps/server/src/mcp/toolkits/orchestrator/tools.ts:79-92 (a status read acknowledges), docs/orchestration-v2/orchestrator-mcp-server.md 'Delegated Task Lifecycle'. Port four cases from DelegatedCompletionDelivery.test.ts: child finished while the app was closed, owner Stop, duplicate read-ack, resumed turn.

### Workers ask their Lead, not Ash

Phase 2, size M.

**What Ash gets.** When a worker hits a question, the chat that delegated it is woken with that question. It answers when the answer follows from the brief or from Ash's words. Only real choices go up to Ash, with the Lead's recommendation. A blocking delegate wait ends early when a question appears.

**Why.** Verified: the app control cannot read or answer another session's question (FIELDS map, src/features/agent-app/model/agentApp.ts:171-222). A worker's question only shows as 'Needs input' on a card, and Ash has to open the worker himself. This mechanism is what makes 'Ash talks only to orchestrators, and agents ask only what truly needs him' work.

**How.** Add sessions.pending {sessionId} and sessions.answer {sessionId, requestId, answers}. Allow them only for sessions in the caller's own delegation rows, and only for questions; start workers in a full-access runtimeMode so approvals do not come up. When a delegated child's pendingQuestion appears, enqueue a wake into the owning Mono via enqueueMonoSessionCompletion with id question-<session>-<requestId>, and withdraw it when the question clears. Do not wake an owner that is blocked in a delegate wait; the wait returns hasPendingQuestion instead. The first answer wins, checked by requestId. Log every answer on the delegation row. If the Lead cannot decide, it uses the ask-Ash path with its recommendation. Reuse respondHarnessQuestion (App.tsx:10250). T3 to learn from: apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts (wake wording, cancelling when answered), apps/server/src/mcp/toolkits/thread/tools.ts:151-176 (pending-request list/read/respond, approvals refused), packages/contracts/src/orchestratorMcp.ts (hasPendingQuestion).

### A delegation tree you can see and stop

Phase 2, size M.

**What Ash gets.** Each delegated chat knows who delegated it. One Stop on a leadership or Lead chat stops everything beneath it and cancels wake-ups still owed, so autopilot cannot restart the work. The Lead's chat shows one counted line per batch (for example 'Delegated 3: 2 working, 1 failed') with a Stop per row and clickable session chips, instead of opaque tool blocks. A Lead waiting on delegated work reads 'Waiting on 3' rather than idle or done. A worker's chat shows 'Runs on its own - Open <Lead>' in place of the composer.

**Why.** Verified: sessions.stop acts on one session and refuses Monos (agentApp.ts:1043-1066). Sessions have no parent link; the only link is the id pattern app-<caller>-<request> (agentApp.ts:1101). monocodeToolCall.ts labels only shell 'monocode app' calls. Without this, a three-level tree has no single place to stop it, and every delegate call is an unreadable block in the Lead's chat.

**How.** Record delegatedBy {monoId, sessionId, taskId} on the child at sessions.start. Keep the app-<caller>-<request> id so upstream v0.15's sidebar grouping still works after Phase 1. Add stopTree next to onStop: pause the queue, dismiss owed completions (dismissQueuedMonoSessionCompletion, monoCompletionBatches.dismissSession), then walk the delegation rows depth first with the existing per-session stop, after the parent's own stop has finished. Touch only rows owned by the stopped chat, and report any child that failed to stop. Expose it as sessions.stop {cascade:true} and as the delegate tool's task_cancel. Extend monocodeToolCall.ts with a registry of the delegate tool names, using T3's verb/past-tense table, counts of distinct ids and its rule for errors returned as data. Add a roll-up to LaunchedSessionCard. Respect Ash's approved Being built rule (HANDOFF.md Unit 7: jobs under Monos, workers never listed, rows never re-sort), so Being built gets only the count and the stuck reason. T3 to learn from: apps/server/src/orchestration-v2/ThreadManagementService.ts:1093 (stopDelegatedTasks), Orchestrator.ts:9597 and 11102-11118, packages/contracts/src/orchestrationV2.ts:105-112 (lineage), apps/web/src/components/chat/agentSpawnSummary.ts, ThreadRelationshipsControl.tsx, packages/shared/src/t3McpToolPresentation.ts, packages/client-runtime/src/t3ToolSummary.ts, packages/shared/src/orchestrationV2PendingBackgroundWork.ts (what counts as Waiting).

### Honest turn results from Claude (failures, retries, notices)

Phase 2, size M.

**What Ash gets.** A worker that died on a 402, 502, 401 or an overload is reported to its Lead as failed, with the reason, instead of as completed. Chats show a live 'API retry 4 of 10' line and the CLI's warnings. Stuck rows in Being built give the real reason, such as 'billing refused' or 'API overloaded, retrying'. Optionally, short reasoning summaries let Ash see what a Lead is thinking when he opens it.

**Why.** Verified: turnStatusFromResult returns completed for every result with subtype 'success' (src/integrations/harness/providers/claude/claudeProtocol.ts:480-485; upstream is the same). Nothing handles api_retry, informational or model_refusal_fallback messages, and the installed CLI 2.1.302 contains all three. Under autopilot nobody is watching, so a false 'completed' becomes a false report up the tree. The candidate's scan found 76 API errors in 10 days of Ash's transcripts that the Hub would record as completed turns.

**How.** Extend turnStatusFromResult to return failed plus errorClass (usage_limit, provider_error, auth, billing), retryable and resetAt, read from is_error, api_error_status, terminal_reason and the gateway-503 text. Add provider.retry and notice HarnessEvents. Feed the class into session.error, into the Mono completion report (status failed, so the Lead hears about it) and into the Being built stuck reason. Raise the usage notice when rate_limit_event arrives, not at turn end. Never auto-retry a 401 or 402. Optionally pass --thinking-display summarized unless thinking is off. Test against T3's claude_result_is_error fixture. T3 to learn from: apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:2676-2705 (terminalStatusFromResult), 2796-2880 (providerFailureFromResult, providerFailureFromApiRetry), 7200-7270 (notices, api_retry), 1098-1215 (thinking summaries); apps/server/src/orchestration-v2/testkit/fixtures/claude_result_is_error/.

### /goal: a finish line for Leads and workers

Phase 2, size S.

**What Ash gets.** A brief can carry a done condition, such as 'all checks pass and the page is served'. The worker keeps going across turns until Claude Code's own evaluator says the condition is met. A Goal row shows the objective, the number of checks so far and the last check, and Being built can say 'working toward: ...'.

**Why.** Verified: neither the Hub nor upstream handles goals anywhere in src. The installed CLI 2.1.302 contains 'Goal set: ', 'Goal active: ', 'Goal cleared' and goal_met, so /goal already works today but invisibly. It is the CLI's built-in keep-going loop, it suits high agency, and it fits the rule that nothing is done without evidence.

**How.** In claude.ts handleLine, parse the synthetic goal messages and the Stop-hook feedback into a goal.updated HarnessEvent. Add /goal as a built-in slash command next to the compact command. Show a Goal row in the existing UsageLimitNotice/MessageQueue card style and in the Mono header. Let delegate_task take an optional goal, sent as '/goal <condition>' before the brief. Re-issue the goal after a Mono rotation or a resume fallback, because it lives in the CLI transcript, not in the brief. Cap the number of checks, and pause the goal while a limit is armed. Before relying on it, confirm in a dev slot that the CLI honours /goal in stream-json mode, and pin that in the tested CLI range. T3 to learn from: apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1319-1371 (nextClaudeGoal), 4012-4040 (trackClaudeGoal), 6251-6275 (completion); apps/web/src/components/ChatView.tsx:5145-5176 (goal banner); docs/user/composer.md 'Goals'.

### Briefs to a busy chat queue or steer instead of failing

Phase 3, size S.

**What Ash gets.** When the leadership team sends a brief to a Lead that is in the middle of a turn, the brief queues behind the current work, or steers into it when asked. The sender is told 'queued' or 'steered' rather than getting an error, and senders can list or cancel the briefs they queued.

**Why.** Verified: sessions.send and sessions.draft throw 'Session is busy; try again when it finishes' (src/app/App.tsx:10940 and 10996; upstream 11462 and 11518). A long-running Lead is busy most of the time, so Phase 3's leadership-to-Lead delegation fails without this. HUB-PLAN already calls for queueing; T3 adds the modes and the delivery receipt.

**How.** Add mode auto|queue|steer|restart to sessions.send, with briefs defaulting to queue, and return delivery started|queued|steered|restarted. If the target is busy and steer was asked for, submit with followUpBehavior 'steer' where canSteerHarness allows it. Otherwise enqueue in the target's outbox (src/features/sessions/model/messageQueue.ts), deduped by the app request id. A stopped (paused) queue holds. Restart means stop, then resubmit. Add sessions.queue {list|cancel} for the sender's own briefs, and show briefs stuck in a queue on the delegation row. T3 to learn from: packages/contracts/src/orchestratorMcp.ts:443-449 (mode enum), apps/server/src/mcp/toolkits/thread/tools.ts:80-123 (queue tools), packages/contracts/src/worktreeMcp.ts (delivery receipt), docs/orchestration-v2/feature-lifecycles.md 'Steering And Queueing Messages'.

### Autopilot that survives limits, crashes and sleep

Phase 3, size M.

**What Ash gets.** When a 5-hour or weekly limit stops agents, they resume on their own at the reset; this is on by default for Monos and Leads. They show as 'Paused until 14:10' instead of Needs you, and the Lead that delegated the work is told. While autopilot is on, the app relaunches itself after a crash and the Mac stays awake until the autopilot end time.

**Why.** Verified: resuming at reset is a per-session opt-in click (src/features/sessions/model/session.ts:294, App.tsx:9146), and a limited Mono is classed as needs-you (src/features/monos/model/mono.ts:518). Nothing keeps the Mac awake or relaunches the app: there is no caffeinate, power assertion or LaunchAgent anywhere in src or src-tauri/src. The 16 Oct stall was a weekly limit. A weekend away fails if a limit or a single crash strands every agent.

**How.** Add a Hub setting 'Auto-resume at reset', on by default for Monos and Leads with a per-project override, that sets resumeAtReset when the limit state is created. Add T3's guards: ignore a reset time already in the past, cap consecutive auto-resumes, skip archived chats and chats with a pending question, and let a newer message cancel the resume. Add jitter, and resume the leadership team first. Show armed limits as Parked with the resume time in Being built and in the Mono's state, and tell the owner through the delegation row (item 1). Optional, after checking Ash's account: read the per-model weekly buckets (seven_day_opus, seven_day_sonnet and model_scoped are all present in CLI 2.1.302) through the CLI's get_usage. While autopilot is on, install a user LaunchAgent (RunAtLoad, KeepAlive {SuccessfulExit:false}, ThrottleInterval, ExitTimeOut 90, ProcessType Interactive) and remove it when autopilot ends. Also hold `caffeinate -i -w <app pid>` until the end time; keep-awake is a Hub addition, since T3 only documents the need. T3 to learn from: apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts, ClaudeAdapterV2.ts:6849-6930 (rate_limit_event), apps/server/src/provider/claudeUsageLimits.ts, apps/server/src/cloud/bootService.ts:128-175 (the plist keys and why), docs/user/thread-sidebar.md:190-216.

### Show Claude Code workflow runs instead of a spinner

Phase 3, size M.

**What Ash gets.** When a Lead runs a Claude Code workflow, its chat and Being built show the phases and the state of each agent (working, done, failed), with one Stop for the whole run. That makes 'busy' distinguishable from 'stuck'.

**Why.** Ash wants Claude to delegate through workflows big and small (his 15 Oct decision). Verified: isAgentTaskType accepts only local_agent and remote_agent (claudeProtocol.ts:622-625; upstream is the same), so a workflow becomes a plain background-task wait with no member list. The installed CLI 2.1.302 emits local_workflow and workflow_progress.

**How.** Port T3's small parser (apps/server/src/orchestration-v2/Adapters/claudeWorkflowProgress.ts, 183 lines) into claudeProtocol.ts. Emit a workflow.progress HarnessEvent, render a compact group row in AgentTranscript that reuses the Agent tool rows, and stop the run through the existing task stop. Keep fallbacks for message kinds it does not recognise. Leave out tailing each member's transcript at first; if it is added later, keep T3's check that reads stay inside ~/.claude/projects (workflowFileRead.ts). Other T3 references: ClaudeAdapterV2.ts ~3507-5100 (member projection), apps/web/src/components/chat/ThreadLineageWorkflowRow.tsx and WorkflowOpeningBlock.tsx, apps/server/src/mcp/toolkits/orchestrator/tools.ts:105 (workflow stop).

### PR and CI watch that wakes the owning Lead

Phase 4, size M.

**What Ash gets.** A Lead registers the PR it opened, ends its turn, and is woken only when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict. When it wakes, the PR is already checked out in its own worktree, ready to fix. The board shows 'Waiting on CI' rather than idle, and the merged PR becomes the evidence on the ask.

**Why.** Verified: the app control has no PR verbs (agentApp.ts:171-222), and automations fire only when a PR is opened (src/features/automations/model/automationEvents.ts). Ash's release flows (Hivra canary, required checks, merge, prove it is served) are 'push, then wait'. Today an agent polls and burns tokens, or a person babysits the checks. This also replaces the CI waiting done by the studio's merge queue, so the Lead delegating covers it.

**How.** Copy only T3's pure evaluatePullRequestWatch (apps/server/src/orchestration-v2/pullRequestWatch.ts, MIT; keep the notice) into src/features/inbox/model/prWatch.ts. Feed it gh data: statusCheckRollup plus required checks, mergeable, reviewDecision, headRefOid, comments via git_github_work_item_thread, and the viewer's login. Persist watches in SQLite (src-tauri/src/session_store.rs). Run the sweep in Rust about every 2 minutes with one read per PR, so a hidden window cannot pause it, and deliver each wake through the queued-message path. Keep T3's guards: at most 10 comment-only wakes in a row, own comments ignored, and the watch ends on merge, close, Stop or 8 failed reads. Workers cannot watch; the Lead does. Add a PR-head worktree (gh pr view, then git fetch pull/<n>/head into mc/pr-<n>, fast-forward only, setup from the imported project file) so a red-CI wake lands in the PR's own checkout (T3 apps/server/src/git/GitManager.ts:2647-2926). Wrap PR comment text in T3's untrusted-data tags with random ids and defused mentions (apps/server/src/scheduledTasks/webhookTemplate.ts). Add a pull_request_rules block beside session_completion_rules (src/features/monos/model/monoFiles.ts) and to the Lead soul: register every PR, end the turn, never poll. Optional: gh pr merge --auto where the project allows it (never --admin; Promote stays Ash's). Also see T3 PullRequestWatchReactor.ts (sweep, read-failure limit) and packages/provider-core/src/server/runtimeInstructions.ts.

**Built (20 Oct, branch `hub/4-prwatch`).**
- **Rust, `src-tauri/src/pr_watch/`** (own tables `pr_watches` and `pr_watch_wakes`, made by `ensure_tables`): the evaluator is T3's `evaluatePullRequestWatch` ported to Rust with its MIT notice (`eval.rs`), so the poller thread decides without the webview; one change: with required checks, only a required check failing wakes. One GraphQL read per pull request through the user's own `gh` (`github.rs`: checks with `isRequired`, re-runs of a name collapsed to the newest, comments, reviews, review comments, the viewer, the rate limit; more pages for 100+ checks). Every 2 minutes while checks run or mergeability is unknown, else 5; a rate limit or a budget under 200 pauses every read (not a failure); 8 failed reads end the watch with a wake; 10 comment-only wakes in a row end it; merge and close end it with a wake (the merge wake gives the merge commit and the exact `ash_update_ask` evidence for the linked asks, which the owner records only if the merge finishes them). Registering reads the pull request first and counts what it shows as told (the answer says it), so only later changes wake.
- **The checkout** (`checkout.rs`): before a wake is stored, a registered worktree is fast-forwarded to `pull/<n>/head` (only when clean, on the pull request's branch, `mc/pr-<n>` or detached); with none, `mc/pr-<n>` is made from the project's checkout through worktrees.rs with the project's setup, the first time a fix is needed. The project's own checkout is never the wake worktree. Nothing is reset, rebased or pushed.
- **Untrusted data** (`wake.rs`): every value from GitHub (title, URL, branch and check names, authors, comment text) goes between `<github-data-ID>` tags with a fresh id per wake, mentions and `/commands` are broken with a word joiner, a forged closing tag is defused, and a closing note says it is data, never instructions. Wakes start `[MonoCode PR watch]`.
- **Tools**: `prs.watch {repo, number, worktree?, asks?}`, `prs.unwatch`, `prs.status` (`agentAppPrs.ts`; a Mono's own chat only, never a worker, habit run or the checker), and `pr_watch`, `pr_unwatch`, `pr_watches` in `monocode mcp` (`pr_watch/mcp.rs`). `<pull_request_rules>` in the Mono context with the delegate tool (`MONO_PROMPT_VERSION` 21): register every pull request, end the turn, act on the wake, close asks with the merge evidence.
- **Delivery** (`features/pr-watch`): the main window queues each wake in the owner's chat as an app notification (it waits for an idle Mono, never steers), queued before it enters the queue and delivered when it goes out; boot recovery re-queues one that never arrived, once; an owner that is gone ends its watches. The board: an idle Mono with a live watch reads "Waiting on CI: #n" in the Monos rail, and Being built shows each live watch as a "Waiting on CI" job under its Mono with a Stop watching button.
- **Not done**: `gh pr merge --auto`; Ash's Stop on a Mono's turn doesn't end its watches (Stop watching on the board does; H4's cascade Stop can call `pr_watch_remove` with reason `stopped`); a dev copy under a temporary HOME has no gh login, so it reads only through `MONOCODE_PR_WATCH_GH` (a stand-in; dev copies only).

### Context ceiling and live setting changes for long-running chats

Phase 3, size S.

**What Ash gets.** Long-running Leads compact at a sensible size instead of at 800k tokens. A big chat that sat idle longer than its prompt-cache lifetime is compacted before its cache is rebuilt at full price. Changing model, effort or permission mode (for example when autopilot switches on) applies live, without restarting the chat's CLI.

**Why.** The weekly limit is the binding constraint. Verified: there is no autoCompactWindow, resume_return or supportedDialogKinds in the Hub or upstream. Mono rotation fires at 80% of the reported window (src/features/monos/model/monoRotation.ts:16). claudeSettingsKey (claudeProtocol.ts:1101) respawns the CLI on any change of model, effort, fast mode or runtime mode, and the Hub never sends set_model, apply_flag_settings or set_permission_mode to Claude, although CLI 2.1.302 supports all three.

**How.** (a) Add a per-Mono or global ceiling (for example 300-400k) passed as autoCompactWindow (--autocompact), and use min(80% of window, ceiling) in rotationReason; Monos keep their deterministic rotation brief. (b) Record the last-turn time and cache lifetime from result.usage.cache_creation. Before dispatching into a chat that has been idle longer than that with 100k+ tokens, run the existing compaction path, or declare supportedDialogKinds ['resume_return'] and answer the CLI's prompt by policy. (c) Use set_model, apply_flag_settings and set_permission_mode for live changes, and respawn only for the thinking toggle. T3 to learn from: apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:194-240 (claudePromptCacheTtlMs), 1066-1215 (canApplyClaudeSelectionLive, autoCompactWindow), 8322-8380 (resume_return); apps/web/src/components/chat/ContextWindowMeter.logic.ts:13-90.

### Dev slots: an isolated, labelled dev Hub per worktree

Phase dev-setup, size M.

**What Ash gets.** Running the Hub from any worktree opens 'MonoCode Hub Dev - <branch>' with its own data folder, its own port and a DEV ribbon, optionally on a cleaned copy of real chats. Several can run side by side, and none of them can touch the daily app's chats, habits, Keychain items or Ash OS. This is what makes developing the app from inside the app safe.

**Why.** Verified at harvest (since replaced: `npm run hub:dev` now runs `scripts/hub-dev.mjs`, see How): npm run hub:dev was plain tauri dev under the live identifier (package.json:31; src-tauri/tauri.conf.json:5; DEV_BUNDLE_ID is pinned to com.ash.monocode-hub at src-tauri/src/macos.rs:831, with a test at :1020). The data dir comes from app_data_dir() (session_store.rs:77, 20 callers), and vite is pinned to port 1420 with strictPort. So a Lead testing a change opens Ash's live monocode.db, can resume his in-flight chats and run his habits a second time, and a second worktree cannot run at all. The WIP sandbox on fix/harness-continuation-06 @66ebaa3f is a start: identifier com.ash.monocode-hub.sandbox, feature test-copy, release builds only (a debug build panics at lib.rs:246).

**How.** Land the WIP sandbox first (Phase 0 already commits continuation-06). Then turn its compile-time cfg!(feature='test-copy') into a runtime instance kind (daily, dev or sandbox) derived from the identifier, so the hot-reload dev loop gets the same guards: Ash OS bridge off, its own Keychain service, MCP servers and hooks stripped, no auto-continue, habits, reminders or process reaping. scripts/hub-dev.mjs replaces hub:dev: the slot is a hash of the worktree path; vite and hot-reload ports come from the slot, with a free-port probe; a throwaway overlay sets identifier com.ash.monocode-hub.dev-<slot>, productName 'MonoCode Hub Dev', devUrl and devCsp; DEV_BUNDLE_ID is read from config. An opt-in hub:seed-dev copies the live DB with the SQLite backup API (or VACUUM INTO), then deletes in_flight_sessions, automations, habits, reminders, queued messages, orchestration rows and connector logins. It never writes back, and it refuses the live dir or a dir in use. identity-guard.sh accepts the dev suffix for dev slots only, never for hub:build or hub:install. T3 to learn from: packages/shared/src/devHome.ts, scripts/dev-runner.ts (port offset ~L236-262; a worktree's own home outranks an ambient one ~L620-640), apps/server/scripts/migrate-dev-db.ts, docs/operations/development.md 'State and ports', apps/desktop/src/app/DesktopUserData.ts and DesktopEnvironment.ts.

### One app per data folder, a build stamp, and T3's self-hosting rules

Phase dev-setup, size S.

**What Ash gets.** A second copy can never open the same chats: it says which build owns them and exits. Every window and bundle shows its commit, branch and kind. One command lists every Hub bundle, data folder, dev slot and worktree on the Mac with commit and size, which ends the 'which version is this?' mess. Agents that edit the Hub get hard rules so they cannot kill or corrupt the app they run inside.

**Why.** Verified: the single-instance plugin is Windows-only in both the Hub and upstream (src-tauri/src/lib.rs:259-262, Windows-only dependency in src-tauri/Cargo.toml). build.rs embeds no commit, and identity-guard.sh checks only identifiers. Every instance's binary is named 'monocode', so a Lead running pkill by name kills the app that hosts it. This is the cheapest insurance against the kind of failure that hit on 16 Oct.

**How.** In setup, before session_store::init, open <dataDir>/instance-owner.sqlite, run BEGIN EXCLUSIVE and hold that connection for the life of the process. The OS releases it even on SIGKILL. Never delete the file, and retry for about 2 s so a relaunch can take over. If the lock fails, show a native dialog naming the owner from running.json {pid, kind, sha} and exit with a distinct code. Stamp {sha, branch, dirty, builtAt, kind} through build.rs (rustc-env) plus a custom plist key. Show it in the Settings footer, and in the window title for non-daily kinds. Return it from a version action so an agent can prove what is running. hub:doctor = the identity guard plus an inventory of bundles, data dirs, dev slots and worktrees with sha, kind and size. Add T3's rules to CLAUDE.md and to the Hub Lead's soul: never kill by name or pattern, only a PID you captured yourself; never start anything against com.ash.monocode-hub data; use hub:dev slots only. T3 to learn from: apps/server/src/serverOwnership.ts, apps/server/src/serverRuntimeState.ts, AGENTS.md 'The three ways to hurt yourself' (L59-63), apps/desktop/src/app/DesktopAppIdentity.ts.

### Ship to the daily app with a safety net

Phase dev-setup, size M.

**What Ash gets.** One 'Ship' command or button installs a verified build into the daily app. It keeps the previous app and a database snapshot, checks that the new build actually boots, rolls back by itself if it does not, and tells the Lead that shipped it what happened after the restart.

**Why.** Verified at harvest (since replaced: installing goes through `npm run hub:ship`, and `npm run hub:install` is now only its one-time `--legacy` path): hub:install verified the bundle, then ran rm -rf on the installed app and cp -R (package.json:34). There is no previous copy, no snapshot and no boot check. Migrations only go forward (schema_migrations in session_store.rs from line 669), and the updater has no endpoints or key (tauri.conf.json:74-75). When a Lead ships from inside the app, one bad build takes down the tool Ash runs the business from.

**How.** scripts/hub-ship.mjs replaces hub:install. It requires a build whose sha passed the checks, so promotion is by commit. It copies the current app to 'MonoCode Hub (previous).app' and snapshots monocode.db with the SQLite backup API when the build adds a migration. It runs a 'monocode healthcheck' subcommand (dispatched in main.rs next to control and app) that migrates a temporary copy of the DB. It writes update-state.json {from, to, snapshot, state: trial} plus a receipt, quits when idle (or under autopilot), swaps the bundles and relaunches. The new build writes a ready marker once the window, the DB and the hub bridge are up. A detached watchdog (a separate process that kills only PIDs it captured) restores the previous bundle and snapshot if the marker does not appear in time. An early check in main() restores them if the state is still 'trial' after a crash. The resumed Lead, brought back by the existing auto-continue, reads the receipt. Leave out T3's release matrix, notarization and update feed. T3 to learn from: docs/internals/server-updates.md, apps/server/src/serviceLauncher.ts (trial and commit, db-backup, restore marker), apps/desktop/src/updates/updateMachine.ts:220 (detecting an update that did not apply), scripts/smoke-cli-archive.ts.

### Project file: worktree setup and one-click project actions

Phase dev-setup, size M.

**What Ash gets.** A small checked-in .monocode/project.json gives every new worktree a working setup before the agent's first turn: dependencies, .env links, a shared Rust build cache, and optionally a fresh branch from origin. It also adds a cleanup step for when the work is finished. Its named actions ('Run Hub dev slot', 'Check', 'Ship') show up as one-click buttons that Ash or any Lead can run, and later carry each business project's own buttons.

**Why.** Verified: creating a worktree is a bare git worktree add with no hook (src-tauri/src/worktrees.rs:157-232). Searching the Hub and upstream for setupScript, runOnSettle and runOnWorktreeCreate finds nothing. Every worker worktree starts without node_modules or .env today and builds its own multi-GB Rust target, and double delegation multiplies that.

**How.** Model the schema on T3's: scripts[{name, command, icon, runOnWorktreeCreate, hold (default true, the opposite of T3), runOnSettle}], plus startFromOrigin. Read the file only from the project's main checkout, and only after one explicit import into the project record, so a branch from elsewhere cannot run code (T3's rule). Run setup after git worktree add as a child process with a log tail, a timeout and a 'work locally' escape, holding the existing worktreePreparing gate (src/features/sessions/model/messageQueue.ts:39). Pass MONOCODE_PROJECT_ROOT and MONOCODE_WORKTREE_PATH in the environment. The Hub's own script symlinks node_modules only when the lockfile matches the main checkout's (otherwise npm ci), symlinks env files only when they are missing (never replacing a real file), and points target-dir at a shared cache or sccache. startFromOrigin fetches, then branches from the remote-tracking ref, falling back to the local ref if the fetch fails. runOnSettle runs when the ask closes or the branch lands, never in the main checkout. Add actions.list and actions.run, plus a runSetup flag on worktrees.create, to the app control, so the delegate tool's isolation:'worktree' uses the same path. Add a small run menu in MonoCode's styling. T3 to learn from: t3.json, scripts/setup-worktree.ts, packages/contracts/src/t3ProjectFile.ts, apps/server/src/project/ProjectSetupScriptRunner.ts, apps/server/src/orchestration-v2/ThreadLaunchService.ts L520-700 (blocking vs async setup, rollback), apps/web/src/components/settings/ProjectActionsSettings.tsx (explicit import), apps/web/src/components/chat/WorktreeSetupCard.tsx.

### Worktree janitor with a dry-run report

Phase dev-setup, size M.

**What Ash gets.** Settings > Worktrees gets one 'Clean up' report listing every worktree with its size, last activity, whether it is merged, unchanged or dirty, and why it is safe to remove or kept. One tap frees the build output of idle worktrees or removes merged, clean ones. Branches and chats stay, and a chat whose checkout was cleaned gets it recreated on its next turn. Nothing is removed without Ash's OK, and automatic rules stay off until he turns them on.

**Why.** Verified: removal is manual only (WorktreesPage.tsx; worktrees.rs check_removal at L475 and git_worktree_remove at L699). Neither the Hub nor upstream has a cleanup policy, size report or scheduler. HUB-PLAN counts about 45 stale worktrees (31 GB in ~/Worktrees). Parallel workers grow the pile fastest exactly when autopilot is on.

**How.** Add src-tauri/src/worktree_janitor.rs with a pure verdict(worktree, policy, now) function. It ports T3's tests: merge-base --is-ancestor against the fetched origin/default branch, squash merges via the PR head SHA, zero commits ahead, owning session archived or idle for N days. It also ports T3's protections: a running or queued session, open terminals, worktree_lifecycle reservations, and local changes, where the default keeps anything uncommitted, untracked or ignored apart from build output. It never touches the checkout the running Hub was built from. Tier 1 deletes only build output (target/, node_modules, dist) using lstat and never follows symlinks (continuation-06's node_modules links to the main checkout). Tier 2 runs git worktree remove on clean worktrees that are merged or pushed. Park the session and recreate its checkout on the next dispatch (prune, add, setup) instead of detaching it. Use one managed root, ~/Worktrees/<repo>/<branch> (Ash, 9 Oct); the older studio worktrees are listed once for Ash to adopt or ignore. Run the report at start and from a 'Clean up now' button, report-only at first. T3 to learn from: apps/server/src/storageCleanup.ts (cleanWorktrees ~L560-850, localChangesReason L496, merged check L169, grace periods L58-66), apps/server/src/worktreesDirectory.ts, apps/server/src/orchestration-v2/ProviderTurnStartService.ts:455-490 (recreating a missing worktree), apps/web/src/components/settings/StorageSettings.tsx.

### Restart-safe resume: what was cut, crash-loop cap, dead-session recovery

Phase dev-setup, size M.

**What Ash gets.** After an install, crash or reboot, an interrupted Lead resumes with a short note listing the subagents and background tasks that were cut, with their ids so it can restart them. A turn that keeps crashing the app stops after three tries and shows in Needs you instead of looping. A chat whose Claude transcript is gone starts fresh from its brief instead of failing on every message.

**Why.** Shipping the Hub from inside itself restarts it while Leads are running. Verified: the resume prompt is a bare 'Continue from where you left off.' (src/features/sessions/model/inFlight.ts), and the auto-continue effect (App.tsx ~9985-9993) counts no attempts. Nothing handles 'No conversation found' (CLI 2.1.302 emits it), so a dead provider session id is reused on every send.

**How.** Persist the background roster (labels and subagent ids from claude.ts Live.backgroundTasks) and a continuationChain counter in the in_flight_sessions row (session_store.rs). Build T3's bounded note (at most 10 entries of 160 characters) into the continue text. Reset the counter when a turn completes; at 3, stop and show the chat in Needs you. Skip chats that are archived or waiting on a question or approval. In claude.ts, treat a result with num_turns 0 and 'No conversation found' as a dead session: clear providerSessionId, emit providerBound(undefined), retry once as a fresh session using the deterministic brief (monoRotation.ts / handoff.ts), mark the chat 'recovered from a brief', and re-issue its /goal. Have one owner build this together with item 1, since they share the boot sequence. T3 to learn from: apps/server/src/orchestration-v2/RestartContinuation.ts (MAX_CONTINUATION_CHAIN = 3, restartContinuationBlocked), RestartBackgroundNote.ts, ProviderTurnStartService.ts:660-760 (fresh native session plus handoff), docs/user/updating.md:38-55.

### Fake-Claude test bench with evidence

Phase dev-setup, size M.

**What Ash gets.** The whole delegation chain is proven end to end in a sandbox Hub with a scripted fake Claude: the Lead delegates, the worker runs, a question is routed, the report wakes the Lead, the app restarts midway, and a cascade Stop works. It costs no tokens, the weekly limit does not affect it, and each run leaves an evidence folder with a verdict to attach to the ask. Real recorded Claude traffic replays through the adapter in the unit tests.

**Why.** The delegate tool and double delegation are exactly what unit tests cannot prove, and Ash's rule is evidence, not 'looks right'. Verified: claudeLive.test.ts feeds hand-written lines through a mocked child process, and there is no recorder, fake CLI or scenario runner. harness_resolve_configured already accepts a custom binary path (src-tauri/src/harness.rs:386), which gives the fake CLI a way in.

**How.** Write scripts/fake-claude.mjs to play a scenario NDJSON with these steps: expect_outbound; emit_inbound, with an optional delay; run_tool, which executes 'monocode app ...' with the injected app env; runtime_exit. Select it through the binary override, in dev and sandbox kinds only. Copy T3's 18 recorded Claude fixtures (data only; keep the MIT notice) with a small replay helper that feeds handleLine and checks the HarnessEvents. Add an opt-in, redacted recorder at the core/child boundary that writes the CLI version into each fixture's header. hub:verify-live runs the scenarios in a throwaway dev slot and writes evidence/<run>/ (a DB copy, the event stream, verdict.json). Its --fail-gate negative control must exit non-zero. One pass with the real model stays separate. Optionally add a tested CLI range constant that warns before a CLI update. T3 to learn from: packages/provider-testing/src/fakeCli.ts, replayTranscript.ts, replayGate.ts, TestProviderHost.ts; apps/server/src/orchestration-v2/testkit/fixtures/claude_*; docs/orchestration-v2/testing-strategy.md; apps/server/scripts/verify-background-live.ts; docs/operations/background-verification.md.

## Skip

- **Multi-model fan-out, mid-thread engine handoff and fork/merge-back (already covered, do not port)**: MonoCode already covers it: sessions.start takes harness, model and worktree and is idempotent, and handoff.ts and monoRotation carry history without a model-written summary. Fork/merge-back is not needed.
- **Already covered by MonoCode: accounts, catalog, permissions, idle parking, orphan cleanup, updater**: Already in MonoCode (providerAccounts, claudeCatalog, the four runtime modes, idle parking, harness_updates, the orphan reaper). Keep them intact through the v0.16 merge.
- **Usage history by project and Mono (where did the limit go?)**: An M-size scanner over about 8 GB of transcripts for a question asked rarely. Limit healing and the context ceiling deal with the cause; revisit only if limits keep biting.
- **Usage report page: tokens and estimated cost by period, model and (added for the Hub) project / Mono**: Duplicate of usage history, with the same reason. Cost estimates would also add a price table someone has to maintain.
- **Attention-first chat list: priority statuses, roll-up, Working fold, return-order, auto-settle, undo**: Today and Being built are Ash's inbox, and his approved Being built rule (HANDOFF.md Unit 7) says rows never re-sort. The one useful piece, a Lead showing 'Waiting on N delegated', is folded into the delegation-tree item.
- **Secret request card: agent asks, Ash answers privately, agent gets only a reference**: Connectors already store keys in the Keychain from Settings. T3's design depends on tools that accept a secret reference, but MonoCode agents run shell commands, so the hard part (keeping a key out of transcripts once an agent holds it) is unsolved. Revisit in Phase 4 if agents keep needing one-off keys.
- **Point-and-comment on the app's own UI (element pick + note as a chip), browser panel later**: Nice, but M-size for a feedback path Ash already covers with screenshots. Revisit once dev slots exist, since the picker would live only in dev builds.
- **Already covered by MonoCode (do not port) + small leftovers**: Composer queue and steer, search, notifications, the quit flow, reminders and checkpoints are already in MonoCode. Adding hub pages to the Cmd+Shift+P palette is an optional one-liner the next time someone touches it.
- **Per-project landing policy: merge method, auto-merge, merged -> settled -> cleanup chain**: Landing main stays with the studio until Phase 2 replaces it, and Promote is Ash's alone. The useful parts (gh pr merge --auto where allowed, the merged PR as evidence, then cleanup) come with the PR-watch and janitor items.
- **Start, clone, publish a project (the git half of New project)**: Phase 4 already plans a real New project flow. T3 only adds a checklist to follow there (managed folder, git init, first commit, optional private repo behind an explicit toggle, background clone with progress), not a separate build.
- **Already in MonoCode: commit and PR text, PR creation, per-turn undo, worktree-isolation checks (do not port)**: Already in MonoCode, and its checkpoint store is at least as careful as T3's. Swapping it would break applySessionCheckpoint and upstream merges.
- **PR review extras: review guides, viewed-file marks, draft line comments, stacks, more hosts (skip)**: Ash does not review diffs line by line; this is scope creep.
- **Outside-agent door: a token-gated way in for agents that were not started by the hub**: The leadership team and Leads are moving into the hub, so fewer callers come from outside. The one piece needed, a stdio 'monocode mcp' subcommand that inherits the turn's app token, is part of the delegate tool already decided. Long-lived outside tokens add an attack surface for little gain now.
- **Calm attention alerts: a transition-only policy now, phone push later (no relay)**: Mac notifications plus Today already cover attention on the Mac. Push that fires only on changes matters only with a phone, and the phone comes later (Mac first, Ash 14 Oct).
- **Phone as a hub client: Today with one-tap answers, plus share-sheet capture**: Mac first (Ash, 14 Oct). Upstream's phone companion arrives with the Phase 1 merge and already reaches Monos, and this would need Ash's own Apple build.
- **Webhook and minute-interval triggers that land in the owning chat**: L-size, and it opens a public way into a Mac that runs agents, which is a prompt-injection surface. Habits and automations already poll for business events; revisit when an event truly needs push.
- **Webhook-triggered automations with untrusted-data framing**: Same reason as the webhook triggers. Its untrusted-data framing is taken inside the PR-watch item, for external comment text.
- **Scoped pairing grants and per-device sessions**: One owner on his own devices. Upstream's single-use mutual-TLS pairing is already stronger on transport.
- **T3 Connect: cloud relay, managed tunnels and route manager (do not port)**: It is a second product (accounts, database, queues), which goes against 'simple, no bloat'. Tailscale or the existing remote-address setting can cover access from away later.
- **Local structured trace log for control calls, delegation chains and app lifecycle**: Delegation rows plus the Autopilot log already answer 'what happened' at the level needed. Add a one-line control-call log only if a delegation bug calls for it.
- **Resource pressure monitor with identity-checked stop controls**: Arrives with the Phase 1 merge: upstream v0.16 has src-tauri/src/resources.rs and background_work.rs (checked). Add Mono and Lead labels afterwards only if needed.

## Notes from the ranking pass

Paths: T3 paths are relative to the t3code clone in the scratchpad. Hub paths are relative to /Users/ash/Projects/monocode-hub (branch docs/hub-plan @8bc1eba0).

What I checked myself (read-only):
- Owed reports are an in-memory Map held in a React ref (App.tsx:8586, monoSessionCompletion.ts:134).
- Busy refusals in the Hub at App.tsx:10940/10996 and upstream at 11462/11518.
- The app control's FIELDS list has no pending/answer, cascade Stop, PR, actions or version verbs (agentApp.ts:171-222), and sessions.stop refuses Monos.
- turnStatusFromResult maps every 'success' result to completed, and isAgentTaskType accepts only local_agent and remote_agent, in both the Hub and upstream.
- The Claude adapter has no goal, api_retry, autocompact or live set_model handling.
- resumeAtReset is opt-in, and a limited Mono is classed needs-you.
- The single-instance plugin is Windows-only in both the Hub and upstream.
- hub:dev ran under com.ash.monocode-hub with the live data dir (since replaced: `scripts/hub-dev.mjs`; vite is still pinned to port 1420 with strictPort).
- hub:install was rm -rf plus cp -R (since replaced by `hub:ship`; `hub:install` is its `--legacy` path), and the updater is unconfigured.
- build.rs stamps nothing, and worktree create has no hook.
- There is no keep-awake or LaunchAgent anywhere.
- The WIP sandbox exists on fix/harness-continuation-06 @66ebaa3f.
- Upstream v0.16 has resources.rs and background_work.rs.
- Every cited T3 file exists.

A read-only string scan of the installed Claude CLI 2.1.302 binary found all of these: 'Goal set/active/cleared', goal_met, local_workflow, workflow_progress, autoCompactWindow, --autocompact, resume_return, supportedDialogKinds, set_model, apply_flag_settings, set_permission_mode, api_retry, model_refusal_fallback, rate_limit_event, get_usage, seven_day_opus, seven_day_sonnet, model_scoped, and 'No conversation found'. So the CLI side of every Claude item exists. How each behaves in stream-json mode still needs one check in a dev slot.

Corrections to the candidate evidence:
- App.tsx is 13,877 lines, not 11k.
- HANDOFF.md Unit 7 (approved by Ash) says Being built shows jobs under Monos, never workers, and its rows never re-sort. That rule shapes the delegation display and rules out T3's sidebar ordered by return time.

Which candidates were merged into each take:
- Item 1: durable delegation record, restart-safe delegation reports, and the report-back half of 'keep working through restarts'.
- Item 2: worker questions.
- Item 3: cascade Stop, delegation shown in chat, and the 'Waiting' state.
- Item 4: CLI failure classes.
- Item 5: native /goal, the /goal row, and the /goal half of the workflow item.
- Item 6: send to a busy session.
- Item 7: both auto-resume / limit-survival items, relaunch after a crash, and keep-awake.
- Item 8: workflow display.
- Item 9: both PR-watch items, the PR-head worktree, and the untrusted-data framing.
- Item 10: context cost control.
- Item 11: all five dev-instance candidates.
- Item 12: the ownership lock, the build stamp and the self-hosting rules.
- Item 13: both self-update / promote items.
- Item 14: project actions, the scripts file, the bootstrap hook with shared cache, the setup half of worktree lifecycle, and start-from-origin.
- Item 15: janitor, storage cleanup, retention, and the cleanup half of worktree lifecycle.
- Item 16: resume hardening and capped auto-continue.
- Item 17: test harness and replay corpus.

Order:
- Start the dev-setup track right after the Phase 1 merge, because it touches macos.rs, lib.rs and tauri.conf.json, which conflict with upstream. Finish it before any Lead edits the Hub from inside it, in this order: 12, 11, 14, 16, 13, 17 (the acceptance gate for Phase 2's delegate tool), then 15.
- Phase 2 builds items 1-5 with the ledger and the delegate tool. One owner should build 1 and 16.
- Items 6, 7, 8 and 10 go with Phase 3's leadership team and autopilot.
- Item 9 goes with Phase 4's studio port, where it replaces the merge queue's wait on CI.

Choices only Ash can make (queue them with ash_ask_ash, recommendation first):
- (a) Should dev slots be seeded from a cleaned copy of real chats? Recommend yes: opt-in, local only, with habits, automations, in-flight turns and logins removed. Note the WIP sandbox's rule was never to copy the daily DB.
- (b) Should auto-resume at reset be on by default? Recommend on for Monos and Leads, with a retry cap and jitter.
- (c) Should worker chats replace the composer with 'Runs on its own - Open <Lead>'? Recommend yes, with a 'type anyway' escape.
- (d) The first janitor run over the roughly 45 studio worktrees. The plan already requires his OK for this.

Tips from T3 for the delegate tool (the tool itself is already decided):
- Host it as a stdio 'monocode mcp' subcommand next to 'app' in main.rs. It then inherits the turn's MONOCODE_APP_ENDPOINT and MONOCODE_APP_TOKEN (control.rs:476-481).
- Give its mcpServers entry a long timeout. Claude Code aborts an MCP call after 60 s unless the server config sets a timeout; T3 uses 65 min (ClaudeAdapterV2.ts:1240-1250).
- Pre-approve its tools.
- Route questions to the delegating chat, never approvals.

Build rules:
- Put each feature in new files plus one hook, to keep upstream merges small.
- Take no T3 engine code. Only small MIT pieces are worth copying, each with the notice: evaluatePullRequestWatch, the webhookTemplate framing, the 18 Claude replay fixtures and the gateway-503 regex.
- Keep-awake (item 7) is a Hub addition; T3 does not have it.
- Claude Code does all the development; Codex is for images only.
