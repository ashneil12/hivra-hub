# WP-197a: A reviewer that runs the changed app before delivery

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | L | 40, 42, 43, 81, 87 | no |

From PLAN.md, "From Aether", item 5. Reviewing every pull request in a connected repository is
[WP-197b](WP-197b-review-every-pull-request.md). Aether is closed source: ideas only, nothing credited.

## Goal

Before a crew's branch is delivered, a separate reviewer (not the worker that wrote it) starts the app from the base
and from the branch, uses both the way a person would, and files what it found as a verdict with before-and-after
screenshots and, where the browser can record one, a short video. The verdict is a gate: "changes requested" stops
delivery the way a red check does.

## What Hivra has

- WP-40 gates (`src-tauri/src/gates.rs`, `GateRun`) and the verify stage (`verify_stage.rs`): the project's own checks
  and a real-path recipe from `.monocode/project.json`, run only after the person imported it; a step that could not
  run is `couldNotExercise` or `notRun`, never a pass.
- WP-42 (`src-tauri/src/plugins/verify.rs`): the e2e Verify plugin; proof the worker leaves under `.e2e/` is attached to
  its report. That is the worker proving itself.
- WP-43 (`src-tauri/src/browser/engine.rs`): a pinned browser engine with per-agent profiles and a visible Stop.
- WP-81 (`src-tauri/src/delivery_gate/`): a local check in a throwaway copy before the branch reaches GitHub.
- WP-87 (`src-tauri/src/stacks.rs`): a stack per worktree with its own ports; WP-82 (`worktree_pool.rs`) ready
  worktrees.
- WP-117's `independent-review` skill (mcode): a reviewer that sees only the diff, the requirement and test results.

## What to build

1. **A `run-review` gate kind** in `gates.rs`, per project, off by default. When a worker reports done and the other
   gates pass, the gate starts a reviewer.
2. **The reviewer** is a fresh worker brief (through `delegate_task`, so routing, limits and approvals apply) on a
   different CLI or model from the author where one is signed in (WP-13's route, with the author's pick excluded). It
   gets two pool worktrees, base and head, each with its own WP-87 stack, the brief's definition of done, the diff, and
   the `independent-review` skill. It never sees the author's conversation.
3. **Running both.** The reviewer starts each copy with the project's imported run recipe (the verify stage's
   real-path recipe), drives the pages or flows the diff touches with the browser plugin, and saves a screenshot of
   each step in both copies under the head worktree's `.review/` (same names, so they pair). With the browser engine
   able to record, it saves one short video per copy; otherwise the verdict says "no video".
4. **The verdict** is a typed report: `approve`, `changes requested` (each finding with the step, what it expected,
   what it saw, and the screenshot pair) or `could not run` (with the step that failed). Code checks the report: a
   finding without a screenshot or a step is refused back to the reviewer once, then counts as `could not run`.
   `could not run` never passes the gate.
5. **Where it shows:** the worker card and WP-81's delivery check show the verdict and the before-and-after pairs side
   by side; the first mate gets "changes requested" as a wake with the findings, and the worker gets one fix round
   (WP-40's rule).
6. Both stacks and worktrees are stopped and returned when the review ends, whatever the verdict.

## Rules

- Off by default per project (Settings > Delivery > "Run the app and review it before delivery").
- Runs only an imported recipe; never a command from the branch itself. A project without a run recipe says "add a run
  recipe to use this" and the gate does not apply.
- The reviewer is never the author and cannot edit the head worktree beyond `.review/`.
- No new outward network call; the app under review may make its own calls (WP-90's fake services are the way to stop
  that, when the project uses them).
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists).
- Upstream rules from PLAN.md: new modules; `gates.rs` gets one new kind.

## Done when

- [ ] Red first: a gate test where a fake reviewer reports `changes requested` and delivery is not blocked today; it
      fails, then delivery is blocked.
- [ ] Tests: the reviewer's route excludes the author's CLI and model when another is signed in; a finding without a
      screenshot is sent back once; `could not run` fails the gate; worktrees and stacks are returned on every path.
- [ ] A fake-Claude run of the whole loop on a fixture web app with a deliberate bug: the reviewer reports it with a
      screenshot pair, the fix round clears it, the gate passes.
- [ ] Browser spec `tests/browser/run-review.spec.ts`: the setting, a seeded verdict with pairs side by side.
      Screenshots in the PR.
- [ ] `npm run check` passes. A dev-copy check on a real project stays open until done.

## Not in this package

Pull requests not made by a crew (WP-197b). Posting to GitHub. Reviewing Hivra's own native window (WP-42 notes no
engine drives a native desktop app yet).
