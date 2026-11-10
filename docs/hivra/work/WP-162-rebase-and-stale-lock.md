# WP-162: Rebase on conflicts and stale programme-lock takeover

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| First Mate smoothness (Ash 10 Nov 00:14 UK) | S | WP-159, WP-12 delivery (on main), WP-160 helpful | yes |

## Goal

When a programme package's PR conflicts with `main`, the First Mate (or its lead tick) can **merge or rebase main into the package branch** in that package's worktree, never force-push, and never touch `main`. When a programme lead lock is stale (owner process gone past a lease), another First Mate session in the same project may take it over with a logged reason.

## Why

Tonight's CoS lead rebased conflicting PRs and took over a stale lead lock so the batch did not stall. Hivra's delivery path already refuses merge on conflict (`delivery/merge.rs`) and tells the person to bring the PR up to date, but nothing in the programme loop does that update, and there is no programme-level lead lease.

## Read first

- `src-tauri/src/delivery/merge.rs` (conflict refusal), worktree helpers, WP-82 pool leases.
- Puppetmaster leases / idempotent launch keys (ideas in WP-60). firstmate hard rule: never tear down unlanded work.

## Build

1. Docs to `docs/hivra/work/WP-162-rebase-and-stale-lock.md`.
2. `programme.update_from_main(packageId)`: in the package worktree only, `git fetch` + merge (default) or rebase (project setting), push the package branch with a normal push. Refuse if the worktree has uncommitted work, if the branch is not the package's, or if the ref is `main`. Tests with a temp git repo fixture.
3. Programme lead lease: `lead_lock` row with `holder`, `expires_at`. Tick acquires; heartbeat extends; expired lock may be taken with an activity-log line. Tests for acquire, refuse while fresh, takeover when stale.
4. Wire optional auto-update-from-main into WP-160's tick behind a project setting **Update conflicting packages from main**, off by default.
5. Out of scope: force push, `--no-verify`, deleting worktrees with unlanded work, merging to main from here.

## Done when

- [ ] Conflict update never force-pushes and never edits `main`.
- [ ] Fresh locks are respected; stale locks can be taken with a log line.
- [ ] Setting off means the tick only reports the conflict.

## Licence

Ideas from Puppetmaster leases (MIT) already named in WP-60. No new vendored code required unless a brief item later says so.
