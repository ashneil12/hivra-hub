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
| completed, gates pending / failed | working / failed |
| failed on a usage limit | paused |
| failed, cancelled, taken over | failed, with what happened |

## Steering and decisions (WP-14)

| What | Where |
| --- | --- |
| A message to a running worker is stored first, then steered in or held for the next turn; pending, delivered or failed, across restarts | `src-tauri/src/steering.rs`, `model/steering.ts` (`planDelivery`, `drainPending`), `hooks/useSteering.ts`, tool `task_message` |
| One decision per stable key; answering releases every waiting task | `src-tauri/src/decisions.rs`, tool `ask_person`, the Needs rows in `hub/model/localHub/decisions.ts` |
| A worker (or a first mate under a first mate) never asks the person | `decisions.rs` `check_may_ask` |
| Caps refuse with a reason, never cut: 8 open tasks per first mate, 20 waiting messages per worker, message and question lengths | `firstmate/mod.rs` `check_fanout`, `steering.rs`, `decisions.rs` |

Credits: the role rules, the brief scaffold, the isolation check, the status protocol and the steering section are
adapted from [firstmate](https://github.com/kunchenguid/firstmate) (MIT, Copyright (c) 2026 Kun Chen). The planner
rules follow ROMA's ideas (no text taken). See `NOTICE`.
