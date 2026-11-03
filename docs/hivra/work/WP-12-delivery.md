# WP-12: Delivery modes and merge authority

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | M | 10 | no |

## Goal

Each project chooses how finished work arrives, and one function decides whether anything may merge.

## Why

SPEC.md section 4, step 7: firstmate's delivery modes (`no-mistakes`, `direct-PR`, `local-only`, plus `yolo`) and
its rule that red is never merged.

## Read first

- firstmate: `AGENTS.md` section 7 ("Selected delivery path"), `bin/fm-pr-merge.sh`, `bin/fm-teardown.sh`.
- `src-tauri/src/land.rs` (lands a worker's changes into the project as one patch), `src-tauri/src/pr_watch/`,
  `src-tauri/src/worktree_janitor.rs`, `src-tauri/src/worktree_lifecycle.rs`.

## Build

1. A per-project setting, stored locally: **local** (land the change into the project with `land.rs`, nothing
   pushed), **PR** (push the worker's branch, open a PR whose body carries the brief and the worker's evidence),
   **checked PR** (as PR, but the result is only reported ready once its checks are green; a red check sends the
   worker one fix round with the log). Default: checked PR when the project has a GitHub remote and `gh` is signed
   in, otherwise local.
2. A separate **merge allowed without asking** switch per project (firstmate's `yolo`), off by default.
3. **One merge path** used by every caller: refuses red or pending checks, refuses while a decision on that work is
   open, and asks the person unless the switch is on. Every merge is logged with who allowed it.
4. Teardown never removes a worktree whose work hasn't landed or merged (check what the janitor already guarantees
   and add tests where it doesn't).
5. `pr_watch` events feed WP-11's classifier (CI red, merged, closed).

## Done when

- [ ] Tests for each mode with a fake remote (a local bare repo and a stand-in for `gh`, as `MONOCODE_PR_WATCH_GH`
      allows), the merge refusals, and the teardown guard.
- [ ] `npm run check` passes.
