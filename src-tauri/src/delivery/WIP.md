# WP-12: where this stopped (paused 3 Nov 23:59 to save usage)

Written, not yet compiled or run:
- `src-tauri/src/delivery/` (settings, deliver, merge, events, teardown, github seam, tests.rs)
- hooks: `lib.rs` (mod + commands), `session_store.rs` (ensure_tables), `pr_watch/mod.rs` (`apply` feeds
  `delivery::events`), `fs.rs` (Inbox merge goes through `delivery::merge::by_person`), `worktrees.rs`
  (orchestration removal runs `delivery::teardown::guard`), `land.rs` (`landed_in`).

Next, on resume:
1. `cargo test -p monocode --lib delivery` and fix compile errors / failures.
2. Small TS wrapper `src/features/delivery/model/delivery.ts` (+ test), maybe a `pr_merge` MCP tool via `prs.merge`.
3. `npm run check` (fmt, clippy, tsc, vitest); Windows clippy with `x86_64-pc-windows-gnu`.
4. Fill PR #16's description (evidence, Mac-only checks list), mark ready, tell the integration thread.
Delete this file before marking ready.
