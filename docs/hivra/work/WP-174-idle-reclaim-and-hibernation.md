# WP-174: Idle reclaim and hibernation, a quiet chat gives back its process

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| D (proposed by the Paseo study; the Orchestrator.inc study said "candidate after WP-164"; Ash to place) | M | 11, 146 | no |

## Goal

A chat whose turn has settled, and that nobody is looking at, stops its provider process after an hour of quiet. The chat keeps its identity, timeline and saved provider session. The next message, an opened view or a wake from the queue brings the same conversation back under the same id through the agent's own resume. A chat that is working, waiting on the person, or holding a permission card is never stopped.

## Why

Two studies reached the same package from different sides, so this one draft replaces both.

Orchestrator.inc (Apache-2.0) keeps a durable hibernation fact and a boundary table. It never hibernates a session that is provisioning, busy, waiting for input, blocked on approval, or idle after a turn with no confirmed outcome. It hibernates only after a settled idle turn with no view open, and only when the native conversation can resume.

Paseo (Apache-2.0, getpaseo/paseo, `docs/agent-lifecycle.md`) has the lifecycle shape: a `closed` state that releases the process but keeps the record, a one-hour idle collector, a daemon baseline plus a provider veto before anything is closed, and a dead runtime reported as a turn error.

Hivra has no equivalent. The word "hibernate" does not appear in the app or the Rust side, and the Paseo study found that nothing in the harness or session store reclaims an idle process, so a Mac or a remote box with many chats or Monos holds one CLI process per chat for as long as the app runs. Ash runs many chats at once, so this matters once a few are idle. WP-11 already supplies the clocks and the classifier, and T3 Code's restart-safe resume plus WP-11 cover recovery after a crash. This package covers the quiet, healthy case.

Open question for the brief: the Paseo study states that an idle chat keeps its provider process; the Orchestrator.inc study did not trace it. Build step 1 settles it by measurement. If no idle chat holds a process, this package is not needed.

## Build step 1: measurement (done, stopped here)

Result: an idle chat does hold its agent CLI process, but only for about three minutes after its turn settles. The app
already reclaims it. Reclaim is not built, because the proposed collector, closed state and load path would duplicate
what exists. Evidence is from reading the code and its tests; no live dev-copy run was made.

- Claude runs as a persistent child: `--output-format stream-json --input-format stream-json`
  (`src/integrations/harness/providers/claude/claudeProtocol.ts`, `buildClaudeSpawnArgs`). It waits on stdin between turns.
- Every settled turn arms a park timer: `scheduleIdlePark` in `src/integrations/harness/core/registry.ts`, from the
  `finally` of `sendHarnessTurn`. `HARNESS_IDLE_PARK_MS` is 3 minutes. Its timer calls `stopHarnessSession`, which
  calls the adapter's `stopSession`. For Claude that is `stopClaudeSession` (`claude.ts`), which calls `killChild`, then
  Rust `harness_kill`.
- Rust kills the whole process group (`signal_tree` in `src-tauri/src/harness.rs`: `kill(-pid)`, then SIGTERM and SIGKILL
  escalation). MCP servers and subagents in that group go with the CLI.
- The resume state is kept (`stopSession` is documented as "kill the child but keep resume state"), so the next message
  starts the CLI again with `--resume` (`claudeResume.test.ts`).
- A warm-limit (`IDLE_AGENT_LIMIT_DEFAULT` = 3, `settings.ts`) parks the longest-idle extra warm CLIs sooner, sparing the
  chat on screen. The 3-minute timer ignores that on-screen check, so the chat on screen is parked too after three minutes.
- Which CLIs resume by id: the adapters that implement `bindSession` and keep resume state. Only Claude was traced here.

Defect found, now fixed (afbf95e60): the 3-minute park did not check for background shells. A turn is let go after
`SHELL_HOLD_MS` (60 s) when only backgrounded shells remain (`holdForShells` and `finishActiveTurn` in `claude.ts`), and
the park then stopped the tree about three minutes later, killing a dev server or watcher the agent had started. The fix:
an adapter can report `hasBackgroundWork`. Claude reports backgrounded shells and monitors, workflow runs, a follow-up
turn on its way and subagents that have not completed (`claudeHasBackgroundWork`). While work runs, the park rechecks
every 30 seconds and keeps the chat. Once the work ends, the chat gets a full idle time before it is parked. The warm
limit skips busy chats too. A provider that throws counts as busy. Tests: `registry.test.ts` ("idle park with background
work") and `claudeFakeCli.test.ts` (a real background shell and a real subagent through the Claude adapter).

Follow-up, done: every other harness adapter implements `hasBackgroundWork`. Codex reports an open agent row until
the turn closes it (Codex force-closes leftover rows because a closing state is often missing; a command execution
is not background work). OpenCode reports child sessions until they go idle or error (no backgrounded shell; an idle
that arrives before the child is bound is not revived; a retry status stays busy). Cursor reports a background agent
tool, including a `cursor/task` that arrives after `session/prompt` returns and settles the ones already seen.
Hermes reports its background map while the session is live (the turn usually waits for the manifest, and a prompt
error still stops the process). Devin reports a subagent that started with an agent id until `subagent_completed`
(a spawn with no agent id does not count). Pi and omp report a subagent whose `details.async.state` is `running`
after the launch tool returns, including a completion that arrives on the next turn. Grok, fx and antigravity report
none: `session/prompt` is awaited for the whole turn, and their ACP handling has no signal for work that outlives it. Build steps
2 to 6 of full hibernation were not built. This follow-up is only the other adapters' checks.

## What to take (ideas only, written from the designs)

- Hibernation is a process boundary, not a display status. The board keeps using activity and PR facts.
- A closed chat has no live provider process, but identity, timeline, workspace, labels, title, usage, attention and parent are kept.
- One load path. Opening a closed chat, sending it a message, or a wake from the queue resumes the saved provider session under the same chat id, in the background. Provider history is not written again when the timeline already has it.
- The boundary table, turned into tests row by row. A chat is never closed while any of these holds: it is starting or provisioning; a turn is running; it waits for input or holds an open approval or question; its last idle turn has no confirmed outcome; a delivery is queued or a wake is queued; a lifecycle operation is in progress; a working child (Monos or subagents) is running; a first mate is waiting on it. A provider can add a stricter check. A false, error or timeout answer keeps the runtime. Nothing overrides a veto.
- Idle collection. A chat is closed only after its runtime has been idle for the idle time (default one hour, a setting). The collector sweeps every 30 seconds while any chat is idle, and checks at once when a chat view closes.
- A runtime that exits while idle is reported as a turn failure, so the chat lands in error with a timeline note instead of looking healthy with its background work gone.
- Reload releases the old runtime before it resumes the saved session, because an idle provider can still hold an exclusive writer. A failed close keeps ownership and blocks the replacement. A failed reopen leaves the chat closed and retryable, and does not block other chats.
- A failed wake is shown in the chat and retried only by a person's action or the next message. Never in a loop.
- The boundary is written to durable state, so a restart reads it as a planned stop and not a crash. A restart does not wake closed chats on its own.
- Off by default, behind a host setting, until the live check below passes. Turning the default on afterwards is Ash's call.
- The resume prompt, `Continue from where you left off.`, becomes a setting with the same default.

## Read first

- `src/features/sessions/model/session.ts`: `sessionNeedsInput` and `hasPendingApproval`, the read-time checks this must respect.
- `src/features/sessions/model/approvalWait.ts`: the held-card path.
- `src/features/monos/model/workerStall.ts` and WP-11: the stall classifier and the wake queue, which count as pending work.
- WP-146 (approval carry) and WP-161 (what already scales under machine load, so this does not duplicate it).
- Orchestrator.inc `docs/architecture.md`, "Chat hibernation boundary", and Paseo `docs/agent-lifecycle.md` (ideas only).

## Build

1. Record, in the brief, whether an idle chat keeps a live provider process, and which CLIs resume a native conversation by id. If none keeps a process, stop here.
2. One pure function decides keep or close from the boundary table and the provider veto. Each row is a test.
3. The closed state and the one load path, so a closed chat reopens under the same id.
4. The collector: the idle time, the 30 second sweep, the immediate check on view close, and the setting that turns it off.
5. The dead-idle-runtime report, the reload order (release first, then resume), and the durable boundary for restarts.
6. The Inbox and tab list rows for a closed chat, and the resume prompt setting.

## Don't

- No new status, lane or badge on the board, and no new mode, second inbox or second orchestrator. A closed chat shows as closed in the Inbox and the tab list only, which are lists that already exist.
- Never stop a chat that a first mate is waiting on, or one that has a queued wake.
- No model call and no token spend in the collector (a test asserts it).
- Don't close a runtime the provider says is still working, however quiet it looks.
- No Orchestrator.inc or Paseo code, prompt or docs text. Port the rules and write the code from the design.
- `src/app/App.tsx`, `src-tauri/src/lib.rs` and `src/features/settings/ui/SettingsView.tsx` stay hook-only.

## Owned paths

- `src-tauri/src/lib.rs` (hook only, as PLAN says)
- `src-tauri/src/harness.rs` and `src-tauri/src/session_store.rs` (collector and runtime release, via a hook)
- `src/features/sessions/model/` (closed state, load path, idle clock inputs; includes `session.ts` and `approvalWait.ts`)
- `src/features/monos/model/workerStall.ts`
- `src/features/inbox/` (closed rows and the "send brings it back" copy)

## Extends

WP-11 (watcher clocks, classifier, restart is a non-event) and the restart-safe resume credited to T3 Code. WP-146 supplies the held approval card this must respect. If Ash prefers, this folds into WP-11 as an addendum; the closed state and collector are the parts that would need a new section.

## Done when

- [ ] Tests for each row of the boundary table, and the idle clock: one hour idle closes; a running turn, an open approval, a pending delivery and a working child each block closing; a provider veto of `false`, an error or a timeout keeps the runtime.
- [ ] A chat holding a permission card or a pending question is never stopped (tested).
- [ ] A restart with closed chats wakes none of them until asked (tested).
- [ ] Test: a closed chat reopens under the same id with its timeline intact; a failed reopen leaves it closed and retryable and does not block another chat.
- [ ] Test: a runtime that dies while idle lands in error with a timeline entry.
- [ ] Browser spec: a closed chat shows as closed, and sending it a message brings it back.
- [ ] Live check on a dev copy: a settled chat with no view releases its process, and its next message resumes the same conversation.
- [ ] `hub:verify-live` passes with the collector on (it kills the app between phases).
- [ ] `npm run check` passes.
- [ ] Orchestrator.inc and Paseo are credited in SOURCES.md, credits.json and the PR (ideas only).

## Licence

Ideas only from two sources, both Apache-2.0. No code, prompt or docs text is copied.

- Orchestrator.inc (https://github.com/OrchestratorInc/agent-orchestrator). Its LICENSE file carries no copyright line.
- Paseo (getpaseo/paseo).

Both are listed in SOURCES.md and in the inspirations list of credits.json.
