# WP-187b: A refused model moves to the next link in the chain

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 187a, 13 | no |

From PLAN.md, "From oh-my-hermes", item 2 (the next candidate named when a provider refuses a model). oh-my-hermes is
MIT (read at commit `2676c33`); idea only, credited per SOURCES.md.

## Goal

When a provider refuses the model or effort a worker asked for ("model not available on your plan", "unknown model",
"this effort is not supported"), the worker is started again on the next link of its chain, once per link, and its
card says so in one line: "Opus was refused (not on this plan), so it moved to GPT-5 on Codex."

## What Hivra has

- `src-tauri/src/crew/failure.rs`: `failure_kind` sorts a failure into `Kind::Account`, `Usage`, `Again` or `Task`;
  there is no class for "this model or effort was refused".
- `src-tauri/src/crew/reroute.rs`: `decide` reroutes account failures to `next_candidate` (another CLI, presence
  order) under the failure budget (`crew/budget.rs`); every try is an `Attempt` in the `crew_attempts` table.
- `src-tauri/src/model_router.rs`: for custom model routes only, `is_effort_refusal` spots a refused effort, drops it
  for that route for the rest of the run (`remember_refuses_effort`) and tells the webview
  (`EFFORT_REFUSED_EVENT`). Claude models never go through the router.
- WP-187a: `Route.chain`, the remaining links in order.

## What to build

1. **A refusal class.** `failure.rs` gains `MODEL_REFUSED` and `EFFORT_REFUSED`, detected from each adapter's own
   failure text and HTTP status with narrow patterns, one recorded fixture per CLI covered (Claude Code, Codex,
   opencode, Hermes). Claude's go beside the existing ones in `src/integrations/harness/providers/claude/fixtures/`;
   the others get a `fixtures/` folder in their provider folder. A new `Kind::Refused`. Unknown text stays in its old
   kind.
2. **The decision.** `decide` handles `Kind::Refused`: take the next link of `Route.chain` that is not in the attempt
   ledger and whose CLI is present; start the worker on it with the same brief; record the attempt with outcome
   `chain`. An `EFFORT_REFUSED` on a link first tries the same model one effort rung lower (the catalog's order) before
   moving to the next link. No chain, or the chain used up: today's behaviour (`first-mate`).
3. **The budget.** Chain moves count against the same failure budget as reroutes, so a run of refusals cannot loop.
4. **One line** on the worker card and in the activity log, built by one pure function from the attempt row, never
   from model prose. The first mate hears it as a normal wake only when the chain is used up.
5. `model_router.rs` keeps its own effort memory; when a router route has a chain, its refusal also feeds step 2.

## Rules

- Only refusals move down the chain. A task failure, a usage limit and a sign-in failure keep their existing paths.
- Never starts a worker on a CLI the person has not signed in to; never uses a model the catalog does not offer.
- Off by default in effect: with no chain set (WP-187a's default), nothing changes (tested).
- No new outward network call. Never weakens approvals or the protected-path list
  (`src/shared/security/agentConfigPaths.json`, when it exists).
- Credit oh-my-hermes (MIT) for the idea in the PR.
- Upstream rules from PLAN.md: crew modules are Hivra's own; adapters get no new behaviour beyond their fixtures.

## Done when

- [ ] Red first: a recorded Codex "model not available" output is not classed as a refusal today; the test expects
      `MODEL_REFUSED` and fails, then passes.
- [ ] Tests: refusal moves to link two; effort refusal tries one rung lower first; a used-up chain goes to the first
      mate; the budget stops a loop; a usage limit does not move down the chain; no chain gives today's decision.
- [ ] A fake-Claude test: a worker refused on its first link restarts once on the second and finishes.
- [ ] Browser spec `tests/browser/crew-chain-refusal.spec.ts`: the worker card's moved line from a seeded attempt.
- [ ] `npm run check` passes.

## Not in this package

Setting chains (WP-187a). Probing which models an account has before starting. Retrying the same link.
