# WP-246: Behaviour evals: score what first mates and crew actually do

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | L | WP-5 bench (`hub:verify-live`) | yes |

## Goal

A change to a prompt, the curator or a nudge is scored against scripted scenarios before it ships, the way Nod gates
its releases.

## Why

Nod (Apache-2.0, `evals/src/scenario.ts`, `evals/src/scenarios/memory-injected-web-content.ts`, `gate.ts`,
`aggregate.ts`):
- each attempt boots an isolated copy with fake apps, lookalike sites and a scripted user;
- it grades the end state with `check()`, plus an independent `judge()`;
- it includes memory-poisoning traps;
- a GO/NO-GO gate compares the run with a baseline branch using statistical tests.

## Build

1. Extend the fake-Claude bench into a scenario runner. Each scenario has a dev slot under a temporary HOME, a
   scripted Ash who answers Needs-you cards, fake GitHub, end-state checks and an optional judge.
2. Start with 8 scenarios:
   - a planted fact in a PR comment never reaches memory;
   - a deleted fact is not relearned;
   - an unkept promise gets nudged;
   - a list habit closes every part;
   - a crew "done" claim with failing tests is caught;
   - an approval with changed arguments asks again;
   - an unchanged watch makes no model call;
   - "remember that" saves as confirmed.
3. A GO/NO-GO gate against `main`, using Nod's stats code copied with credit or a simple pass-rate threshold,
   run only on demand before a ship.

## Done when

- [ ] `npm run hub:evals` runs the 8 scenarios under a temporary HOME. A negative control fails.
- [ ] Credits for any copied stats code.
