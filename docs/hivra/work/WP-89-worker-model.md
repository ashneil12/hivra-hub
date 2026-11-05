# WP-89: Change what your workers run on, anywhere, in one step

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| H | M | 13 | yes |

## Goal

The person can set which CLI, model and effort a first mate's workers use, for one Mono, one project or every
worker in the app, from the screen or by telling the first mate in plain words. Every place that sets it shows what is
in force and where it came from, so nobody has to guess what a worker is running on.

## Why

Ash, 5 Nov: "it should be super easy to change your worker subagents model and effort via the UI or just letting your
first mate know, and it can be just for that Mono or for the entire system."

What exists today, so nothing stacks:
- **Per project:** the project menu's Workers popover (E7, `ProjectWorkers` in `src/features/hub/ui/ProjectMenu.tsx`,
  stored by `projectWorkerModel` / `setProjectWorkerModel` in `src/features/monos/model/workerPool.ts`). Claude models
  only.
- **Crew rules** (WP-13, WP-21): ordered rules per project and per Mono that match a task's **labels or paths** and set
  CLI, model and effort (`src/features/crew/model/rules.ts`, `resolve.ts`, `taskRoute.ts`, Settings > Crew). A rule
  must name a label or a path, so there is no "all of this Mono's workers" rule.
- **`app tasks.workers`** (`src/features/agent-app/model/agentAppTasks.ts`): the first mate already reads and sets the
  project's worker limits from chat ("let hivra run 20 workers today").

Missing: a default for one Mono, a default for the whole app, the first mate changing either by chat, and one place
that says which setting won.

## Read first

- WP-13 (crew routing and its precedence), WP-21 (rules stored on a Mono), WP-10 (the first mate contract).
- `resolve.ts` (`resolveRoute`, `roleModel`), `taskRoute.ts` (how a route becomes a worker launch), `workerPool.ts`
  (E7 project model, limits, `savedWorkerLimits` for export), `agentAppTasks.ts` (`workers`, `tasks.workers`).
- `src/features/sessions/model/models.ts` (`modelsFor`, `resolveModel`, `modelEffortSetting`): the catalog decides
  which models and efforts are real.

## Build

1. **One worker default per scope.** A default is `{ cli?, model?, effort? }`, each field optional. Three scopes:
   - **Mono:** stored on the Mono beside its crew rules (WP-21).
   - **Project:** the existing E7 setting, widened from a Claude model to the same three fields. Existing saved
     values keep working unchanged (a stored `model`/`effort` reads as `{ cli: "claude", model, effort }`).
   - **System:** one app-wide default in the app's settings store, beside the worker limits.
   All three travel with Export and import the way worker limits do (A10), and import only adds.

2. **One precedence, per field, in one function.** Extend `resolveRoute` (and its Rust twin in
   `src-tauri/src/crew/resolve.rs`, kept in step by the existing tests) so each of CLI, model and effort is taken from
   the first of:
   1. what the caller named for this task (the override), then the brief's request;
   2. the first matching crew rule (the Mono's rules, then the project's, then plugin rules), unchanged;
   3. **the Mono's default**;
   4. **the project's default**;
   5. **the system default**;
   6. the app's usual rule (today: the default CLI, Sonnet, a stronger model for a hard job).
   A field a higher step leaves empty stays open for the next one, as today. `FieldSource` gains `"mono"`,
   `"project"` and `"system"`. A model or effort the catalog doesn't offer for the chosen CLI is skipped for that field
   (as `taskRoute.ts` already does), and the place that set it says so. Planning help and verdict checks keep their
   cheap model (`roleModel`); this package doesn't change them.

3. **When a change applies.** A worker started after the change uses it; one already running keeps what it started
   with; one still queued picks it up when it starts. Nothing restarts a worker.

4. **On screen, three places, one control.** One small component (CLI, then model, then the effort the model offers)
   used in:
   - Settings > Crew: **Default for every worker**, above the rules list.
   - The Mono's settings: **Model for its workers**.
   - The project's Workers popover: the existing control, now with the CLI choice.
   Each shows one line with what is in force and where from, e.g. "Its workers use Opus 4.7 at high effort (set for
   this Mono). Crew rules still send `frontend` work to Sonnet." "Use the default" clears that scope. A worker's start
   card names its CLI, model and effort and where they came from.

5. **By chat, through the existing action.** `app tasks.workers` gains `scope` (`"mono"`, `"project"` or `"system"`),
   `cli`, `model`, `effort` and `clear`:
   - With none of them it reads: the chat's limits as now, plus what is in force for this Mono and project, field by
     field with its source, and each scope's own setting.
   - With them it sets (or, with `clear: true`, clears) that scope. A plain model name ("opus", "grok 4") is resolved
     through the catalog; an unknown one, or an effort the model doesn't offer, is refused with the list it does offer.
   - Every answer carries `line`, one plain sentence of what changed and what is now in force, including any crew rule
     that still wins for some work. The first mate tells the person that sentence.
   - The tool description teaches the mapping: "for this Mono" is `mono`, "for this project" is `project`, "for
     everything" or "everywhere" is `system`; with no scope named, ask once ("just this Mono, or everything?") unless
     the chat's context makes it plain.
   - Only a Mono's own chat may set it (the same caller check as `app.ship`: never a worker, a habit run or the checker).
     `mono` is only the caller's own Mono; `project` only a project it works on. Each change posts a small card in that
     chat with **Undo**, and goes into the activity log (WP-78).

6. **Dev copies** keep their own settings; tests use the stand-in catalog and the fake Claude.

## Done when

- [ ] Unit tests (TS and Rust): the precedence, field by field, with every source; a rule still beats a Mono default;
      an unknown model or effort is skipped with the reason; old project settings read as before.
- [ ] Agent-app tests: read, set and clear for each scope; plain names resolve; refusals for unknown model, wrong
      effort, a worker or habit caller, another Mono and an unworked project; the `line` text.
- [ ] A worker started after a change uses it; a running one doesn't change; a queued one does (fake Claude).
- [ ] Browser spec: Settings > Crew default, the Mono's setting and the project popover each show the line in force,
      and clearing falls back to the next scope.
- [ ] Export and import carry the Mono and system defaults.
- [ ] `npm run check` passes.
