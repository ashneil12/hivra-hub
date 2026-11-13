# Testing policy

Ship fast. Tests are fixed at a real release, not on every change. Heavy proof (the full suite, a launched build,
a live run, mutation testing) is for a release, except for a short list of paths that are always gated. The aim is
to find a bad change quickly and undo it quickly, not to stop every change at the door.

This page adapts the owner's shipping report to this repo. It adds no gate: nothing here fails CI or blocks a ship
by default, and `hub:ship` and `--skip-tests` mean what they meant before.

## The tiers

| Tier | When | What runs here | Does red block? |
| --- | --- | --- | --- |
| T0 Agent loop | While you work, before every push | `npm run check:affected`: the web and script tests that reach a changed file, `tsc --noEmit`, and the Rust check only when a change reaches it. Add a command output or a screenshot as proof | Yes for you: do not push red |
| T1 Pull request | A ready PR (drafts run nothing) | The same affected run in CI, plus the report-only `guards` job (`npm run check:guards`, which includes the sensitive-path report) | A red check blocks the merge. The guards never do |
| T2 Main | After every merge to main | `npm run check`: all web, script and Rust tests | Does not stop other work. The author of the change fixes forward or reverts |
| T3 Ship | `npm run hub:check-all`, then `hub:ship` | The full `check`, the built bundle launched under a temporary HOME (`hub:launch-check`), `hub:verify-live` with the fake Claude, then the ship's own trial and automatic restore | Yes. A failed pass record stops the ship. This is the soak and rollback layer |
| T4 Release | A real release or a pre-ship manual CI run | Browser specs, cargo-mutants, `npm run check:guards:strict`, `node scripts/stryker-in-diff.mjs --run`, `node scripts/escapes.mjs --replay`, cross-platform builds | Yes. This is where the tests get fixed |

How each piece works is in [AGENTS.md](../AGENTS.md) ("Development basics", "Ship") and in
[shipping-guards.md](hivra/shipping-guards.md). Do not copy their details here.

## Always gated

A change to a path in [sensitive-paths.json](hivra/sensitive-paths.json) is never fast-laned, at any tier: keys and
secrets, approvals and permissions, the agent sandbox, spend accounting, database schema, CI and release scripts,
the updater and installers, and the identity guard. Before it lands it gets the full relevant tests (not only the
affected ones), a hard review by a second reader, and the owner's say if it changes how the gate itself works.

`npm run check:sensitive` lists which changed files are on that list. It only reports.

## When a test goes red

The short rules are in AGENTS.md ("When a test goes red"). The reasons:

- Classify before you touch anything. Most lost time is spent fixing the wrong thing.
- A test that is not fixed in 10 minutes or 2 attempts is quarantined (`docs/hivra/quarantine.json`, with an owner
  and an end date), so work continues. `npm run check:guards` reports a quarantined test past its end date.
- A test that passes only because it was weakened, retried, skipped or deleted is worse than a red one: it hides the
  bug and the red. `scripts/test-guard.mjs` reports the visible cases.
- Critical tests, golden files and formal specs encode what the owner decided. An agent does not change them alone.
- Whoever lands a change owns the red it causes. Three review rounds is the limit, then rethink.

## Keeping the suite lean

Write tests that check behaviour through the public surface, not internal call order. A test is worth keeping if it
fails when behaviour breaks and survives a refactor that keeps behaviour. Rewrite or delete the rest, and name the
behaviour a deleted test guarded and what covers it now. Do not write tests that restate a constant or a mock.

`npm run check:test-diet` lists test files edited 3 or more times in the last 90 days. A test that keeps changing
without ever catching a bug is a candidate to rewrite as a behaviour or golden test, or to delete. It only reports.
Look at it monthly. Also worth a glance monthly: the quarantine list, the escape ledger, and how long a PR waits.

## What is not decided here

- Marking a test critical (there is no tag yet): the owner picks the first set, from the sensitive paths.
- Moving a CI job between tiers or making a guard strict by default: the owner decides.
- Formal models (state machines such as orchestration and resume) are a later step, not part of this policy.
