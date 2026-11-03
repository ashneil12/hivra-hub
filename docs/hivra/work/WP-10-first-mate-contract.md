# WP-10: First mate contract

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| A | L | none | no |

## Goal

One contract every first mate follows (the coding team and every Mono), enforced by code where it can be: what a
first mate may do, the brief it sends, the report it gets back, and the five statuses everything shows.

## Why

This is the core of Hivra (SPEC.md section 4). firstmate's contract and DeepSeek's "the router never executes",
on top of the Hub's delegation engine, which already works and stays.

## Read first

- SPEC.md section 4 in full.
- firstmate: `AGENTS.md` sections 1, 4, 5, 7, 9; `bin/fm-brief.sh`; `bin/fm-classify-lib.sh` (MIT; vendor text with
  credit).
- ROMA's planner and atomizer rules (ideas only, no licence: don't copy text).
- AgentOS: the Assignment and the first mate role contract (MIT).
- `src-tauri/src/delegations.rs` (states, delivery, generation, tree, stalls, blocked), `src-tauri/src/mcp_server.rs`
  (`delegate_task`, `task_status`, `task_wait`, `task_cancel`, `task_answer`, `task_cannot`),
  `src/features/monos/model/delegations.ts`, `delegationStore.ts`, `leadFlow.ts` (what it replaces).

## Build

1. **Role rules**, as a prompt contract in one file (`src/features/firstmate/contract.md` or similar), vendored
   from firstmate where it fits: the first mate reads, plans, briefs, supervises and reports; it never edits a
   project; it never merges without the person's word unless the project allows it; it never discards unlanded
   work; it reports failures as they are; messages are outcomes. Small, clear asks go straight to one worker;
   larger ones get 3 to 8 independent tasks plus one synthesis step, each with a completion condition.
2. **Enforcement** of "never edits", per CLI: run the first mate's own session read-only where the CLI supports it
   (Codex's read-only sandbox; Claude Code without edit tools and with writes to the project denied; check what
   each CLI in `harness.rs` supports and document it). For every CLI, a check after each first-mate turn: if the
   main checkout changed and no landing explains it, the turn is flagged and the change is offered for revert.
3. **Brief scaffold** in code: a template with fixed sections (isolation check, intent, spec, definition of done,
   status protocol, steering) where the model fills only intent, spec and definition of done. `delegate_task`
   refuses a brief with empty or placeholder sections. The brief is stored on the delegation row.
4. **Worker report**: a typed final report (summary, files changed, checks run and their results, evidence links,
   open questions). A worker's opinion of its own work is recorded but never counts as evidence.
5. **Status vocabulary**: one function, `derive_status(row, gates)`, returns working, needs you, done, failed or
   paused. Map today's states: running and stalled are working (a stall is a notice, not a state), question and
   blocked are needs you only when the question is for the person (a worker's question goes to its first mate
   first), completed is done only once WP-40's gates pass, a usage-limit wait (`resets_at`) is paused. Expose it to
   the UI; nothing else computes a status.
6. **Depth cap**: `delegate_task` refuses a delegation deeper than 2 (first mate, first mate, workers), with a plain
   reason.

## Don't

- Don't change the delegation table's existing columns or the delivery state machine; add to them.
- Don't build UI here (WP-15) or the watcher (WP-11).

## Done when

- [ ] Tests: a brief with a placeholder is refused; depth 3 is refused; `derive_status` covers every state,
      stall kind, question owner and gate result.
- [ ] Tests: a first-mate turn that edits the main checkout is flagged (fake CLI from `scripts/fake-claude.mjs`).
- [ ] The read-only enforcement per CLI is documented in the PR, with what was tried for each.
- [ ] `npm run check` passes; `hub:verify-live` still passes.
