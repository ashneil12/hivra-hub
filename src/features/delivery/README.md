# Delivery (Hivra WP-12)

How finished work arrives in a project, and the one function that decides whether anything may merge.
The engine is Rust (`src-tauri/src/delivery/`); this folder holds the webview's typed calls.

- **Modes**, one per project, stored in the app's own database (`delivery_settings`):
  - **local**: the worker's change lands in the project with `land.rs`; nothing is pushed.
  - **PR**: the worker's branch is pushed and a pull request opened whose body carries the brief and the worker's
    report (its evidence; its own opinion of its work is shown as that, never as proof).
  - **checked PR**: as PR, but the result is reported ready only once its checks are green. The first red check
    sends the worker one fix round with the failing log; a second red fails the delivery.
  - No choice stored: checked PR when the project has a GitHub remote and `gh` is signed in, otherwise local.
- **Merge without asking** (firstmate's `yolo`), per project, off by default.
- **How tasks are tested** (SC-3a), per project, beside the delivery mode (`delivery_settings.testing_mode`; Settings >
  Crew, `ui/TestingModeSetting.tsx`, `model/testingMode.ts`). `at-ship` is the default and what a project with no
  choice gets: a task only has to build, and tests and review run once, when the person ships. `light` runs the
  project's tests and a quick review on every task that changes code, `full` adds the task's own checks, the real-app
  check and a second reviewer (the extra parts arrive with SC-4, SC-5 and SC-7), and `off` tests nothing. When a worker
  says done, `firstmate::testing_mode::gates_for` picks the gates from the diff and the mode; a task that changed
  nothing and stored no plan is left as it was. A write goes on top of the `updatedAt` it read, so a stale window is
  refused.
- **One merge path** (`delivery::merge`): refuses red or pending checks, refuses while a decision on that work is
  open, asks the person unless the switch is on, and logs every merge with who allowed it (`delivery_merges`). The
  Inbox's merge button and the `pr_merge` tool both go through it.
- **Teardown guard** (`delivery::teardown`): a worktree whose work hasn't landed or merged is never removed.
- **PR events** (CI red, CI green, merged, closed) from `pr_watch` are kept in `delivery_events` for WP-11's
  classifier, and move each delivery along.

Credit: the modes, `yolo` and "red is never merged" come from firstmate (kunchenguid/firstmate, MIT): `AGENTS.md`
section 7, `bin/fm-pr-merge.sh`, `bin/fm-teardown.sh`. The behaviour is ported here. The sentences are vendored in
`src/features/firstmate/vendor/firstmate-contract.md`.
