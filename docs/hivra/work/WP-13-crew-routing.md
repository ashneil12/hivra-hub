# WP-13: Crew routing and reroute

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | M | 10, 16 | no |

## Goal

Each task goes to the right CLI, model and effort by rules a person can read and change, and a task that fails
for account reasons moves to the next worker that can take it.

## Why

SPEC.md section 4, step 3. Any coding agent can be a worker; with several subscriptions, a quota or login failure
must not end the task.

## Read first

- firstmate: `AGENTS.md` section 4 (routing precedence), `bin/fm-dispatch-resolve.sh`,
  `docs/examples/crew-dispatch.json`.
- Puppetmaster's failure classification and `retry(n)` reroute (MIT).
- ROMA's per-role model mapping (ideas only).
- `src-tauri/src/delegations.rs` (`error_class`, `retryable`, `resets_at`), `src-tauri/src/rate_limits.rs`,
  `src-tauri/src/worker_queue.rs` (per-project limits), `src-tauri/src/harness.rs` (which CLIs exist and are signed
  in), `src/features/monos/model/workerPool.ts`.

## Build

1. **Crew rules**, per project and per Mono, stored locally and editable in Settings as a short ordered list: match
   on what the task is (labels the first mate sets, such as `ui`, `backend`, `docs`, `review`, or paths) and pick a
   CLI, model and effort. Precedence: the person's override, then the brief's request, then the first matching
   rule, then the default. Keep the rule store a merge of sources, so a plugin can later add default rules
   (`crew-rules.json` in its Hivra folder, WP-30) beneath the person's own.
2. **Defaults** come from the CLIs that are installed and signed in (from `harness.rs`); a project with none set
   uses Claude Code if available, else the first signed-in CLI.
3. **Role models**: a cheap, fast model for planning help and verdict checks (WP-40), the rule's model for the work.
4. **Reroute**: classify each failure from `error_class`. Account failures (quota, rate limit, auth, billing, CLI
   missing) move the task to the next candidate under a retry budget (default 2), with an attempt ledger on the
   row. Task failures (the work itself failed) never reroute; they go to the first mate.
5. A usage limit with a known reset time (`resets_at`) is **paused** if no other candidate exists, and resumes by
   itself when the time comes (WP-11 timer).

## Done when

- [ ] Tests: precedence order, defaults from signed-in CLIs, each failure class (reroute vs not), the retry budget,
      and pause-then-resume on a usage limit.
- [ ] The rules UI has a browser spec; `npm run check` passes.

## Addendum (10 Nov 2026): a spend ceiling for runs on billed models

Source: Omnigent (Apache-2.0, Copyright (2026) Databricks, Inc. per its NOTICE). Ideas only, no code copied. This overlaps `WP-XX-spend-limits.md` (Paperclip); Ash should choose one home for the money limit.

A run on a model billed by its own provider (any custom model, see `customModels.ts`) carries a spend ceiling per task, and a daily ceiling for unattended runs. At a soft threshold the person is asked whether to continue. At the hard cap the run stops, the task is held for the person, and the reason is recorded on the task row. A reroute from a subscription limit never moves a task onto a billed model without the person's OK. Subscription CLIs keep the rate-limit rules above, since their use is not billed per token.

Tests: the soft ask fires once, the hard cap stops the run and records why, the daily total resets at local midnight, and a reroute never moves a task to a billed model on its own. Done when the ceilings show on the task row and in Settings, and crew rules can set one per project.
