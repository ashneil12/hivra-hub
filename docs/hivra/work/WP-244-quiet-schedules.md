# WP-244: Habits and automations that skip the model when nothing changed

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | M | WP-180a | yes |

## Goal

A watch habit ("tell me if the price changes", "ping me when CI goes red") costs nothing on a quiet run, and says
exactly what changed when something does.

## Why

Nod (Apache-2.0, `src/server/schedules.ts` about lines 270 to 345, `recordObservation()`):
- a schedule with a watch marker skips without a model call when the watched source hasn't changed and the last
  run succeeded;
- the server holds the last value, so "changed from $1,200 to $1,500" is computed, not remembered;
- two runs of one routine never overlap;
- a failed run always notifies.

## Build

1. A habit or automation may name a watch: a URL, a GitHub query or a file. Before the run, the app fetches it and
   compares a digest with the stored one. If nothing changed and the last run succeeded, it records "quiet,
   unchanged" and makes no model call.
2. Store the last observed value (capped at 4 KB). The run gets "Before: ... Now: ..." in its prompt.
3. Never two runs of one habit at once. Every failed run posts one line (this already pairs with WP-196b's
   limits).

## Done when

- [x] Tests:
  - an unchanged watch makes no model call;
  - a change shows before and after;
  - two overlapping ticks run once;
  - a failure posts a line.

## Built

- `src/features/automations/model/quietWatch.ts`: the watch (an https address, `github:owner/repo search`, or a file
  path), the read through the app's existing doors (`page_http_fetch` with the address itself as the only grant,
  the Inbox's `git_github_work_items`, `read_text_file`), the digest, the 4 KB "Before" and the one-run-at-a-time guard.
- Habits: `watch` and `watchSeen` in `habits.json`; `habits.add` / `habits.update` take `"watch"`; a quiet skip is a
  run with `unchanged: true`; a failed run posts one line in the first mate's chat (`useMonoHabits.ts`).
- Automations: the editor's "Only run when this changes"; the watch and its last look live in the local store document
  `schedule-watches` (`automationWatches.ts`), not in the automation's Rust definition. A skipped run is recorded as
  `skipped` with its reason; a failure already writes its activity line (WP-180a).
- A person's Run now always runs (with the before and after); only schedules stay quiet.
- Shots: `docs/hivra/work/shots/wp-244/`. Specs: `src/features/automations/model/quietWatch.test.ts`,
  `automationQuiet.test.ts`, `src/app/hooks/useMonoHabits.test.ts`, `tests/browser/wp244-quiet-watch.spec.ts`.
