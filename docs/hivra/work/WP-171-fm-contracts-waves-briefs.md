# WP-171: First Mate contracts, waves, and stronger briefs (Atomic wiring)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Atomic Agent fold-in (Ash 10 Nov 01:23 UK) | M | WP-10 briefs and contract (on main), WP-40 gates (on main). Prefer after WP-141 lands or branch without a Settings clash | yes |

## Goal

When First Mate fans out a multi-part ask, it can name **provides / requires / owners / checks**. Dependents wait in later waves. Every worker brief quotes a bounded copy of the person's original ask (not only First Mate's paraphrase), and a few Fusion prompt lines fold into the existing brief template and `contract.md`. **No new mode, no flag, no Settings toggle.** Chat First Mate as today; this is just better default delegation.

## Why (Ash 01:23 UK)

Ash rejected a separate "Plan and build" / Fusion mode: First Mate already plans, delegates and keeps tracking, so a mode you switch on is bloat. Take only what genuinely improves existing delegation. Atomic's contracts, waves, original-request-in-brief, and some prompt wording are clear wins. A second orchestrator, two-seat run mode, judge extras and off-by-default flags are not.

Source: [AtomicBot-ai/atomic-agent](https://github.com/AtomicBot-ai/atomic-agent) MIT, commit `1b4e641525c5b1427b48ff6b8d9932dc26bd8256`, Copyright (c) 2026 Atomic Bot. Main files: `src/tools/fusion/contract.ts`, `contract-waves.ts`, `contract-checks.ts`, `worker-prompt.ts`, `src/prompt/fusion-guidance.ts`.

## Read first

- This pack's REPORT.md (section "What we're actually taking").
- Hivra `origin/main`: `src/features/firstmate/model/brief.ts`, `contract.md`, `src-tauri/src/firstmate/mod.rs` (depth, fan-out), `gates.rs`, `report.rs`.
- Do **not** build WP-167's run mode, two seats, or orchestrator lock. First Mate is already read-only. Workers already cannot ask the person (`check_may_ask`) and cannot go deeper than depth 2.
- WP-141 owns crew defaults and routing across Monos/CLIs. Reuse it; do not invent a planner/worker seat pair.

## Design

1. Optional contract on a First Mate multi-delegate (or one fan-out call that already exists): `owners`, `provides`, `requires`, `checks`. Single-task briefs need no contract. Missing requires that name nothing any task provides are refused before start, with a clear reason.
2. Wave planner: tasks with no unmet requires run together (bounded by existing `MAX_FANOUT`); later waves wait for providers. A cycle falls back to one wave in the given order and warns. A failed or cancelled provider holds unstarted dependents and tells First Mate what landed.
3. After each wave, run declared checks and look for declared provides/files. Missing or unrun checks are failures, never passes. First Mate already has WP-40 gates; this adds per-wave contract checks, it does not replace gates.
4. Briefs: keep the existing scaffold and placeholder refusal. Add a bounded **Original request** block (Atomic's idea, ~16k char cap with a truncation note) taken from the person's message that started the turn (and a short follow-up merged with the prior live ask when needed). `intent` still holds First Mate's fill of the person's ask; the original-request block is the raw quote so thin paraphrases cannot send workers off-brief.
5. Fold these lines into `contract.md` / brief fixed text (ideas + short wording, not a mode block): First Mate keeps design and judgement and re-sends weak parts; workers have no parent chat memory; never ask the person, act on the most reasonable reading; a blocked approval path is handed back with the exact path, not retried forever.
6. Out of scope: Plan-and-build mode, two-seat pairing, three-way merge, mid-fan-out resume and stop-one (WP-172), judge, throwaway verify, role models, task tree, dollar caps, Devin picker, llama.cpp.

## Build

1. Copy this file to `docs/hivra/work/WP-171-fm-contracts-waves-briefs.md`. Add or update the Atomic Agent row in `docs/hivra/SOURCES.md` (MIT, that commit, what we take: contracts, waves, original-request brief, prompt lines). Commit docs first.
2. Contract types, validation, wave planner, tests (cycles, unknown requires, provider failure holds dependents).
3. Wire into the existing First Mate delegate path so multi-part fan-outs can carry a contract. No new Settings UI.
4. Original-request block in `renderBrief` / brief assembly; tests for bound, follow-up merge, and stopped-request exclusion if that data is available.
5. Update `contract.md` (and vendored notes only if needed) with the short behavioural lines above. Keep firstmate MIT blocks intact; add Hivra/Atomic lines outside them.
6. Vendor or translate Atomic TypeScript where it fits, with file header, NOTICE (`Copyright (c) 2026 Atomic Bot`), credits.json, README inspirations. `npx vitest run src/features/settings/model/credits.test.ts` must pass.

## Done when

- [ ] Multi-part First Mate fan-outs can declare provides / requires / owners / checks and run in waves. No flag to turn this on.
- [ ] Name mismatches and unrun checks cannot pass.
- [ ] Every worker brief includes a bounded quote of the person's original ask; empty intent/spec/goal still refused.
- [ ] Contract.md / brief text carries the short judgement and worker-frame lines.
- [ ] Credits, NOTICE, SOURCES agree. No Plan-and-build mode or Settings toggle.

## Licence

Atomic Agent, https://github.com/AtomicBot-ai/atomic-agent at commit `1b4e641525c5b1427b48ff6b8d9932dc26bd8256`, MIT, Copyright (c) 2026 Atomic Bot. Vendor or translate with the usual credit files. Ideas need no extra credit. Do not copy analytics.

## As built

- **One new tool, no mode.** First Mate had no multi-delegate call, only one `delegate_task` per task, so a contract
  had nowhere to live. `delegate_tasks` (`tasks.fanout`) carries a plan: each task names what it owns, provides,
  requires and checks. Every task is then an ordinary `delegate` (brief, gates, crew route, limits, checkout).
- **Refused before start:** unknown requires, uncheckable provides, duplicate names, two owners of one path, paths
  outside the project, bad briefs, more than 8 tasks. A requires cycle warns and runs in one wave in the order given.
- **Waves are per task.** A task waits for the tasks that provide what it requires, not for its whole wave. It waits in
  the worker queue and takes no seat. Delivered means: the provider's row is done, its declared checks passed (a check
  with no passing verdict is not a pass) and what it provided is on disk in the project its work landed in. A failed,
  stopped, missing or undelivered provider holds what waits on it.
- **Checks.** A declared check is the id of one of the project's own checks and becomes that task's WP-40 checks gate,
  so it runs in that worker's copy before the task is done. Wave-level checks that name no task are not taken.
- **Original request.** Quoted after the intent in every worker, Lead and remote brief, 16,000 characters, a follow-up
  under 280 characters joined to the message it follows. A task that waits keeps the request it was asked under.
  Atomic's stopped-request exclusion is not taken: the transcript keeps no mark of a stopped turn.
- **Reuses what main has.** With a project's fresh-eyes review on (WP-144), each task goes through it like any
  `delegate_task`, and a provider held for its review counts as not started, so what needs it waits rather than being
  held as lost. A fan-out started from a room comes back to that room. In the chat the call reads like
  `delegate_task` (its row, each worker's card, the live line) and the start-workers and mismatch nudges count it as
  handing work out. The fan-out host is a hook (`useFanoutHost`), so App.tsx only calls it.
- **Not here:** a plan that survives the app quitting mid-fan-out and stopping one worker (WP-172); outcome notes from
  finished waves in later briefs.

