# WP-60: First mate on the remote host

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| D | L | 20 | no |

## Goal

A project on a remote machine keeps its first mate, crew and watcher running with the laptop closed, and the desktop
catches up when it reconnects.

## Why

Vision item 5 (always on) and the base of Hivra Cloud. Upstream's remote host already runs providers and owns
sessions that survive SSH loss; the Hub's delegation records and watcher live only in the desktop today.

## Read first

- Upstream: `docs/remote-access.md`, `host/` (the Node host package), `src-tauri/src/remote.rs`,
  `src-tauri/src/remote_ssh.rs`.
- WP-10, WP-11 (the classifier was built headless for this), WP-12, WP-13.
- Puppetmaster's leases and idempotent launch keys; AgentOS's native-session custody (never replace a live session
  with a fresh one).

## Build

1. For a remote project, the delegation records, the wake queue and the classifier run on the host. The desktop
   reads and writes through the host, as it does for remote sessions today.
2. Leases and idempotent launch keys so a reconnecting desktop and the host never start the same worker twice.
3. When the desktop reconnects, it receives what happened while it was away, from records stamped with what
   started each run (a person, a schedule, a first mate).
4. Local projects keep working exactly as before.

## Done when

- [ ] Tests with a host in a container (or the upstream test host): a brief started from the desktop finishes with
      the desktop disconnected; reconnecting shows the result once; no duplicate workers after a reconnect race.
- [ ] `npm run check` passes.

## Addendum (10 Nov 2026): host inventory is authoritative

Source: Emdash (Apache-2.0, Copyright 2026 General Action, Inc.). Ideas only: nothing copied, nothing vendored, so no NOTICE entry. This adds to WP-60. It takes no new WP number and is about S in size, depending on WP-60.

### Goal

For a project on a remote machine, the machine is the one place that says which worktrees and checkouts exist. The desktop shows what the machine reports. A removal the person asks for is remembered until the machine confirms it, even if the machine is offline at the time.

### Why

Most of this already exists for remote sessions. The host owns the session database, host calls fail fast, and a retried request reuses its command ID (docs/remote-access.md). Two gaps remain, and they matter once remote worktree deletion lands. docs/remote-access.md says that deletion is "not available remotely yet", and WP-60 does not say where its intent would live.

1. Local deletion already has a durable intent. `prepare_removal` in `src-tauri/src/worktrees.rs` writes a `worktree_removals` row before git removes anything, and `reconcile_removals` replays pending rows. A remote version must not fall back to a desktop-only record, such as the localStorage selection that `rememberRemotePendingWorktree` writes in `src/features/connections/model/connections.ts`.
2. Nothing says what the desktop does when a remote path has vanished on the machine.

Emdash describes the same split: the host's inventory is authoritative, the desktop converges toward it, and only a deletion intent may outlive an unreachable host. We take the idea, written in Hivra's own code. We do not copy its code or text.

### Read first

- Emdash CONTEXT.md: Host, Observation, Tombstone, Reconcile sweep, Missing, Observe.
- WP-60 and WP-82 (lease and return rules).
- `docs/remote-access.md`, section "Scope of this first version".
- `src-tauri/src/worktrees.rs`: `prepare_removal`, `finish_removal`, `reconcile_removals` and the startup interruption tests.
- `src-tauri/src/remote.rs`: `remote_request` (fail-fast, "Machine is no longer connected", the host identity check).

### What to take (ideas only)

1. **The machine's list wins.** On open, a remote project reads its worktrees and checkouts from the machine. The desktop never writes a worktree record as if it were the machine's truth. Any desktop record is a hint, replaced when the machine answers.
2. **Deletion intent survives an unreachable machine.** Removing a remote worktree while the machine is offline writes one durable desktop row, keyed by machine id and path, with the same shape as `worktree_removals`. The row shows as pending. When the machine is reachable again, only that deletion is retried. Nothing else is reconciled toward a record.
3. **A refused removal stops and asks.** If the machine refuses (dirty tree, lease held, process still running), the row stays pending with the reason and offers Retry or Forget. Nothing is forced.
4. **A vanished remote path shows as Missing** and is kept until the person removes it. It is not silently dropped.
5. **Identity lost is not local.** A remote project whose machine record was removed refuses host actions and says so. It never runs on this Mac.
6. **Words.** In UI copy, say "machine". In code, say "host". "Project" is the desktop grouping. "Repository" and "worktree" are the git things.

### Owned paths

`src-tauri/src/remote.rs` and `src-tauri/src/remote_ssh.rs` (intent write and read only), `src-tauri/src/worktrees.rs` (a shared removal-intent helper), `src/features/connections/`, `src/features/projects/`. `src-tauri/src/lib.rs` and `SettingsView.tsx` stay hook-only.

### Out of scope

A standing desired state. Convergence of any record other than a pending removal. A worktree pool on the host (WP-82 stays local). New modes.

### Done when

- [ ] A removal made while the machine is offline writes one intent row and shows it as pending. Reconnecting removes it once. A second run does nothing.
- [ ] A refused removal keeps its reason and offers Retry or Forget. Nothing is forced.
- [ ] A worktree removed on the machine shows as Missing on the desktop, and the stale record does not come back as a live worktree.
- [ ] A remote project whose machine record is gone refuses host actions and never runs on this Mac.
- [ ] Tests on a fixture host under a temporary HOME, with a stub that can be taken offline.
- [ ] `npm run check` passes. A native check on a real SSH host is open until it is done.

## Addendum (10 Nov 2026): typed errors on the host and app protocols

Source: HarnessRouter (Apache-2.0, Copyright (c) 2026 HarnessRouter). Ideas only, no code copied. This adds to WP-60.

Every failed call on the host protocol and on the app actions returns one envelope: a type (bad request, permission, busy, server, harness), a code from one closed list kept in one module, a one-sentence message safe to show, and a retry rule (retry as is, retry after the named wait, retry after the person fixes the input, or never retry). Busy means another turn is running in the same session, so the caller waits for that turn to end rather than starting a second one. A caller that gave up on a started task must not assume it stopped: it reads the task's state and cancels it if still running.

Tests: every code maps to exactly one retry rule, and a test fails when a new error string has no code. Done when the list lives in one module and the app actions and host calls use it.
