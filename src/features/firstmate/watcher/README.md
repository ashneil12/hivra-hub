# Watcher and wake queue (Hivra WP-11)

Plain code watches every crew and wakes a first mate only when something needs its judgment
(docs/hivra/SPEC.md section 4, step 5; docs/hivra/work/WP-11-watcher.md). Nothing here calls a model, starts a CLI
or spends a token.

| Part | Where | What it does |
| --- | --- | --- |
| Classifier | `classifier.ts` | One pure function, `classify(event, now)`: a row change, a look at a running worker, a PR event or a timer, to a decision (a wake and its road, a stall to record, a silent worker to stop, or nothing for the model). Headless: `watcher.headless.test.ts` walks its imports. |
| Stall judge | `stall.ts` (moved from `monos/model/workerStall.ts`) | quiet, loop, idle, and the provider-error stall, from a worker's look and presence. |
| Hourly check | `hourly.ts` (moved from `monos/model/hourlyCheck.ts`) | when the hourly progress check is due; its words stay in `hourlyCheck.ts`. |
| Transcript reader | `look.ts` | the app's side: a chat's blocks into the facts the classifier judges. |
| Wake queue | `src-tauri/src/watcher/queue.rs`, `wakeQueue.ts` | durable wakes on the delegation delivery ladder, one per owner and key, drained into one turn, acknowledged through the `seq` it saw. |
| Timers | `src-tauri/src/watcher/timers.rs`, `agent-app/model/agentAppTimers.ts` | `timers.set`, `timers.list`, `timers.cancel`; a due timer becomes a wake in the same transaction. |
| Driver | `monos/model/workerStall.ts` `StallWatch`, `hooks/useFirstMateWakes.ts` | the main window carries out the decisions: writes stalls, queues wakes, stops silent workers, fires timers, delivers. |

## What wakes a first mate

| Event | Wakes? | Road |
| --- | --- | --- |
| Worker done (its status is done: gates passed or none) | yes | its report (delegations.rs) |
| Worker finished, gates still running | no, records only | |
| Worker failed, or gates failed | yes | its report |
| Worker paused on a usage limit, or stopped by someone | no, records only | |
| Worker asks its first mate | yes | the question wake (delegationQuestions.ts) |
| Worker says it can't finish (`task_cannot` on its own task) | yes, once | the queue |
| Worker quiet or idle (a stall) | yes, once per silent stretch | the queue (a provider-error stall: self-repair's note) |
| Worker silent 20 minutes, nothing pending | stopped, failed (retryable) | its failure report |
| CI red, all green, review, conflict, merge or close on the crew's PR | yes | pr_watch's wake |
| A timer the first mate set | yes | the queue |
| Anything else (progress, a stall clearing, a gate starting) | no | records and the UI |

A question or an approval waiting never counts as silence, nor does a queued message, a usage limit, a chat waiting on
its own workers, or a followed Lead's own long-running chat.

## Restart

The records are the truth. A stall stored on a row keeps its stretch's start, so a restart neither repeats a notice
nor restarts the 20 minutes. Wakes and timers are rows: at start the main window fires due timers and drains what each
first mate is owed; a drained turn that already reached the transcript is acknowledged, one that was lost with the
window is drained again, and a notice about a worker that moved on meanwhile is dropped.

Credits: the watcher, the wake queue and its drain follow [firstmate](https://github.com/kunchenguid/firstmate)
(`bin/fm-watch.sh`, `bin/fm-wake-lib.sh`, `bin/fm-wake-drain.sh`, `bin/fm-classify-lib.sh`; MIT, Copyright (c) 2026 Kun
Chen), re-told on the Hub's delivery ladder; no firstmate code is copied. firstmate 74ba960 keeps a Pi arm child armed after that child or a successor dies; Hivra has no arm child, so that fix is not applied (WP-147). The once-per-stretch stall notice is Raven's
idea, the 20-minute silence stop PandaCode's (ideas only).
