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
