# WP-11: Watcher and wake queue

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | L | 10 | no |

## Goal

Plain code watches every crew and wakes a first mate only when something needs its judgment. Wakes are queued
durably, survive restarts, and spend no model tokens until they are delivered.

## Why

SPEC.md section 4, step 5. firstmate's zero-token watcher and durable wake queue, DeepSeek's watchdog, Raven's
stall notice and PandaCode's silence watchdog. The Hub already has most of the parts, spread across the webview.

## Read first

- firstmate: `bin/fm-watch.sh`, `bin/fm-wake-lib.sh`, `bin/fm-wake-drain.sh`, `bin/fm-classify-lib.sh`.
- Raven: `raven/agent/subagent/dag_runner.py` stall notice (around line 152). PandaCode:
  `src-tauri/src/architect/watchdog.rs` (ideas only).
- `src-tauri/src/delegations.rs` (delivery: pending, queued, delivered, acknowledged; generation receipts),
  `src/features/monos/model/workerStall.ts`, `hourlyCheck.ts`, `followedBriefs.ts`,
  `src-tauri/src/pr_watch/`.

## Build

1. **One classifier**, headless: it must run without a window, because WP-60 runs it on a remote host. Rust is
   preferred; a TypeScript module with no React or DOM imports is acceptable. Inputs: delegation row changes,
   session activity and idle events, pending approvals and questions, PR and CI events from `pr_watch`, timers.
2. **Wake only for judgment**: a worker done (after WP-40's gates), failed, blocked, or asking its first mate; a
   stall notice (once per silent stretch, re-armed only after activity); CI red or a merge on the crew's PR; a timer
   the first mate set. Everything else updates records and the UI, never the model.
3. **Silence watchdog**: a worker with no events for 20 minutes and no pending approval or question is stopped and
   marked failed (retryable), and its first mate is woken once. Approvals and questions never count as silence.
4. **Durable wake queue**: generalise the delivery state machine so non-report events queue the same way. The
   first mate's next turn drains the queue first and acknowledges through the generation it saw.
5. Fold `workerStall.ts` and `hourlyCheck.ts` into the classifier; keep their stall kinds and their tests (moved).
6. On start, the classifier rebuilds from records and the queue is drained: a restart is a non-event.

## Don't

- Don't call a model, start a CLI or spend tokens anywhere in the classifier (a test asserts it).
- Don't change how reports reach owners today except by adding event kinds.

## Done when

- [ ] Tests for each wake kind, the once-per-stretch stall notice, the 20-minute silence stop, approvals not
      counting as silence, and queue survival across a simulated restart.
- [ ] `hub:verify-live` passes with the classifier in place (it kills the app between phases).
- [ ] `npm run check` passes.
