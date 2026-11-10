# WP-159: Programme package queue the First Mate owns

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| First Mate smoothness (Ash 10 Nov 00:14 UK) | M | WP-70 tasks (on main), WP-14 decisions (on main), worker_queue (on main) | yes |

## Goal

A project can hold a long-running **programme**: an ordered list of packages (brief path, worktree branch, status, security-park flag) in a durable local state file the First Mate reads and updates. The queue survives a restart. It is not the per-job `worker_queue`; it is the programme board tonight's Chief of Staff kept in `GROKBOT-LEAD-STATE.md`.

## Why

Ash's north star (9 Nov): manage everything from Hivra the way he uses his Chief of Staff bot. Tonight that bot ran for hours from a state file. Hivra already has per-job `worker_queue`, tasks (WP-70) and delivery rows, but nothing that stores "next packages, in flight, parked for Ash" as one programme the First Mate can tick.

## Read first

- `src-tauri/src/worker_queue.rs` (leases, restart-safe order; do not overload it).
- WP-70 tasks, WP-78 activity log, WP-14 decisions.
- firstmate durable wake queue patterns already ported in `src-tauri/src/watcher/queue.rs` (MIT firstmate; reuse ideas of pending/queued/delivered, not a second copy of worker_queue).
- Puppetmaster leases / idempotent launch keys (ideas already named in WP-60).

## Build

1. Docs first: copy this file to `docs/hivra/work/WP-159-programme-package-queue.md`. Add a SOURCES.md row naming firstmate's durable queue (ideas) and that the shape mirrors the external lead state without putting private paths in the repo.
2. Local store (SQLite or a single JSON file under the project's Hivra data folder): rows with `id`, `wp`, `title`, `brief_path` (relative or sandbox path the app resolves), `branch`, `status` (`queued` / `building` / `pr_open` / `merged` / `parked` / `failed`), `security_park` bool, `priority`, `notes`, timestamps. Caps on row count and note length. Tests for append, claim, finish, park, restart.
3. First-mate MCP tools: `programme.list`, `programme.enqueue`, `programme.set_status`, `programme.park` (reason required). Workers are refused with a plain reason (WP-10). Tests.
4. A small Programme panel (or a Home card) listing queued / in flight / parked. Browser spec on Chromium and WebKit.
5. Out of scope: launching builders (WP-160), merging (WP-155), phone, spending, writing outside the project's data folder.

## Done when

- [ ] A programme queue persists across restart; claim/finish/park are tested.
- [ ] Only the First Mate (not a worker) may change it.
- [ ] Parked rows stay parked until the person clears them.
- [ ] No private Mac home paths appear in committed text.

## Licence

Ideas from Kun Chen's firstmate durable wake queue (MIT) already credited in Hivra. No new vendored code required. If any file is translated later, add header, NOTICE, credits.json, README, SOURCES.md.
