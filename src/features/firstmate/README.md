# First mate contract (Hivra WP-10)

One contract every first mate follows: the coding team and every Mono. The model reads
[contract.md](contract.md); code enforces what it can:

| Rule | Where it is enforced |
| --- | --- |
| A brief comes from one template; the model fills only intent, spec and definition of done | `model/brief.ts` (`renderBrief`, `checkBrief`), used by `tasks.delegate` in `agent-app/model/agentAppTasks.ts` |
| A brief with an empty or placeholder section is refused before anything starts | `checkBrief`; the `delegate_task` schema requires `intent`, `brief` and `goal` (`src-tauri/src/mcp_server.rs`) |
| The brief is stored on the delegation row | the row's `brief` is the prompt the worker got, template included |
| Never deeper than first mate, first mate, workers | `src-tauri/src/firstmate/mod.rs` `check_depth`, called by `tasks.delegate` |
| The worker's final report has one typed shape; its opinion is never evidence | `src-tauri/src/firstmate/report.rs`, parsed when the row settles (`report` column); the shape is in the worker rules |
| Five statuses, computed only from the row and its gates | `src-tauri/src/firstmate/status.rs` `derive_status`; every row carries `status` and `statusNotice` |
| A first mate never edits the project | read-only launch where the CLI can (`model/readOnly.ts`), and for every CLI the after-turn checkout check (`src-tauri/src/firstmate/checkout_guard.rs`, `hooks/useFirstMateCheckoutGuard.ts`) |

A chat is a first mate when its `Session.firstMate` is set. WP-20 (coding team) and WP-21 (Monos) set it; until
then the read-only launch and the checkout check are wired but nothing is marked.

## Read-only per CLI

| CLI | Level | How |
| --- | --- | --- |
| Claude Code | enforced | `--disallowedTools Edit,Write,MultiEdit,NotebookEdit` (deny rules hold in bypass mode too). Bash stays for git reads and the app's tools; a Bash write is caught after the turn. |
| Codex | enforced | read-only sandbox, approvals `never`, network on for the delegate tool's loopback, on every thread and turn (the shape a plan turn already runs in). |
| Cursor, Grok, Hermes | checked | after-turn check. Their ACP permission requests could be answered read-only, as their plan turns are; not wired yet. |
| Devin | checked | after-turn check. Its native plan mode plus client-side gating could hold it. |
| Antigravity | checked | after-turn check. Client-side denial of non-read permissions is possible. |
| OpenCode | checked | after-turn check. Its permission config (`edit: deny`) or plan agent could hold it. |
| Pi, omp, fx | checked | after-turn check only; no read-only switch the app drives. |

## The after-turn check

When a first-mate turn starts, the app snapshots the project's main checkout (HEAD, and each path `git status`
lists with a content fingerprint). When it ends, a changed path that no landing explains (a worker's finished work
the app put in during the turn, `land.rs`) flags the turn. A flagged path is offered for revert only if it was clean
when the turn started; the person's own uncommitted edits and commits are never touched.

## Status

| Row | Shown |
| --- | --- |
| running (any judged stall: quiet, loop, idle) | working, with the stall as a notice |
| running, blocked by its first mate | needs you |
| running, blocked by the worker itself | working (its first mate hears it first) |
| question (for the first mate, the default) | working |
| question passed on to the person (`firstmate_set_question_owner`) | needs you |
| completed, no gates or gates passed | done |
| completed, gates pending / failed / unsure | working / failed / working (its first mate is deciding) |
| failed on a usage limit | paused |
| failed, cancelled, taken over | failed, with what happened |

## Steering and decisions (WP-14)

| What | Where |
| --- | --- |
| A message to a running worker is stored first, then steered in or held for the next turn; pending, delivered or failed, across restarts | `src-tauri/src/steering.rs`, `model/steering.ts` (`planDelivery`, `drainPending`), `hooks/useSteering.ts`, tool `task_message` |
| One decision per stable key; answering releases every waiting task | `src-tauri/src/decisions.rs`, tool `ask_person`, the Needs rows in `hub/model/localHub/decisions.ts` |
| A worker (or a first mate under a first mate) never asks the person | `decisions.rs` `check_may_ask` |
| Caps refuse with a reason, never cut: 8 open tasks per first mate, 20 waiting messages per worker, message and question lengths | `firstmate/mod.rs` `check_fanout`, `steering.rs`, `decisions.rs` |

## Contracts, waves and the quoted request (WP-171)

No mode and no setting: this is how a multi-part ask goes out. A single part, or parts that need nothing from each
other, still use `delegate_task`.

| What | Where |
| --- | --- |
| `delegate_tasks`: one call for a plan, each task saying what it owns, provides, requires and checks. Refused before anything starts: a requirement nothing provides, a provide nobody could check, two owners of one path, a path outside the project, a bad brief, more than 8 tasks. A requires cycle only warns and runs in one wave | `model/fanoutContract.ts` (`parseFanout`), `src-tauri/src/firstmate/mcp.rs`, `tasks.fanout` in `agent-app/model/agentAppTasks.ts` |
| Each task is an ordinary delegation: its brief, gates, crew route, worker limits and checkout. A declared check is the task's WP-40 checks gate | `delegate` in `agentAppTasks.ts` |
| A task that requires a name waits in the worker queue, holding no seat, and starts by itself once the provider's row is done, its declared checks passed and what it provided is on disk | `model/fanoutWaves.ts` (`planWaves`, `dependencyVerdict`), `model/fanoutChecks.ts`, `monos/model/workerPool.ts`, `host/fanoutHost.ts` |
| A provider that failed, was stopped, cannot be found or did not deliver holds what waits on it; the line says what landed and what did not start. Nothing that did not run passes | `dependencyVerdict` |
| Every brief carries the contract of its plan, and a bounded quote of the person's own request (16,000 characters, a short follow-up joined to the message it follows up) | `renderBrief` in `model/brief.ts`, `model/originalRequest.ts` |
| Short rules for the first mate and every worker: keep the design and judgement, a worker has no memory of the chat, never ask the person, hand back a blocked path exactly | `contract.md` ("Delegating well"), `workerRules` in `agentAppTasks.ts` |
| With a project's fresh-eyes review on (WP-144), each task is reviewed like any `delegate_task`; a provider held for its review reads as not started yet, so what needs it waits | `heldForReview` in `fresh-eyes/model/gate.ts`, `hooks/useFanoutHost.ts` |
| In the chat the call reads like `delegate_task`: "Handed out 3 tasks", each worker's card anchored on it, the live line "Handing out a job", and no start-workers or mismatch nudge after it. A fan-out from a room comes back to the room | `sessions/model/monocodeToolCall.ts`, `monos/model/monoSpawnedSessions.ts`, `agent-app/model/agentApp.ts` |

Not here: a plan that survives the app quitting mid-fan-out and stopping one worker of a fan-out (WP-172), and a quote that
leaves out a request the person stopped (the transcript keeps no mark of a stopped turn).

Credits: the role rules, the brief scaffold, the isolation check, the status protocol and the steering section are
vendored verbatim from [firstmate](https://github.com/kunchenguid/firstmate) (MIT, Copyright (c) 2026 Kun Chen) in
`vendor/firstmate-contract.md`. A one-line binding follows each block where Hivra has no status file, inbox directory
or captain address. The planner rules follow ROMA's ideas (no text taken). The contract, wave, presence-check and
request-quote code is translated from [Atomic Agent](https://github.com/AtomicBot-ai/atomic-agent) (MIT, Copyright (c)
2026 Atomic Bot). See `NOTICE`.
