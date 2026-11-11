# WP-193a: A machine per task: the lifecycle and its timers

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 60, 61 | no |

From PLAN.md, "From Aether", item 1. Aether is closed source: ideas only, nothing credited. The first real backend is
[WP-193b](WP-193b-machine-per-task-on-a-host.md). A Hivra Cloud backend needs WP-61's service, which does not exist
yet; this package only names its place.

## Goal

A task can run on a machine of its own that exists only for that task: made when the task starts, paused when it goes
quiet, and removed when its pull request merges or closes, or 48 hours after it was last used. Each machine's ready
time is measured and shown, so "how long until the worker could start" is a number, not a feeling.

## What Hivra has

- Ready worktrees on this Mac (WP-82, `src-tauri/src/worktree_pool.rs`, a pinned treehouse binary): leases, return,
  a full pool is a wait. One worktree per task, all on one machine.
- The remote host keeps first mate records on the host with leases and idempotent launch keys (WP-60,
  `host/firstmate/lease.ts`, `records.ts`, `FirstMateRecords`, `launchFingerprint`).
- Hivra Cloud (WP-61) is the app side of a managed machine: sign-in, pairing, account check. It provisions nothing;
  the service is out of its scope.
- The PR watch knows when a pull request merged or closed (`src-tauri/src/pr_watch/`), and
  `worktree_autoclean.rs` already uses that to call a worktree finished.

## What to build

1. **A lifecycle, as pure rules** (`src/features/taskMachines/model/lifecycle.ts`, importable by the host as other
   `src/` modules are): states `requested`, `provisioning`, `ready`, `suspended`, `destroying`, `destroyed`, `failed`,
   and one function `nextStep(machine, facts, now)` that returns the one action due: provision, mark ready, suspend
   (idle 30 minutes, a setting), resume (work arrives), destroy (pull request merged or closed, or 48 hours since last
   use, a setting), or nothing. A machine with a running turn, an open question or approval, or a first mate waiting
   on it is never suspended or destroyed.
2. **A backend interface** (`MachineBackend`: `provision(spec)`, `status(id)`, `suspend(id)`, `resume(id)`,
   `destroy(id)`), and two implementations here: `fake` (tests and the dev copy's bench) and `cloud`, which refuses
   every call with "Needs a Hivra Cloud machine service, which is not set up" until WP-61's service exists. WP-193b adds
   the first real one.
3. **Records.** One `task_machines` row per machine: task, backend, state, created, ready-at, last-used, destroy reason,
   and `ready_ms` (provision start to the first command that answered). Local projects keep it in the app's database;
   a project on a host keeps it in the host's records, so the timers run with the laptop closed.
4. **Ready time shown.** The worker card: "Machine ready in 4.7 s". Settings > Machines (WP-181a's page when present,
   else Settings > Crew) shows the last 20 ready times and their median, per backend.
5. **One sweep** on the existing watcher tick (WP-11) applies `nextStep` and writes each action to the activity log.

## Rules

- Off by default: Settings > Crew > "Give each task its own machine" is off, and stays unusable until a backend is
  set up. With it off nothing in the crew path changes (tested).
- Spends nothing and provisions no paid infrastructure. The `cloud` backend makes no network call.
- A destroy is never forced over a running turn, a question, an approval or unpushed commits on the machine (the
  backend reports them; unknown counts as "keep").
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists).
- Upstream rules from PLAN.md: new modules; the crew launch path gets one hook.

## Done when

- [ ] Red first: a table test of `nextStep` written before the function: idle 31 minutes suspends; a running turn
      blocks suspend; a merged pull request destroys; 48 hours destroys; an open question blocks destroy.
- [ ] Tests with the `fake` backend: a full life from request to destroyed; a provision failure lands in `failed`
      with its reason; `ready_ms` recorded; a restart in the middle resumes from the record, not from memory.
- [ ] Test: the `cloud` backend refuses with its sentence and opens no socket.
- [ ] Browser spec `tests/browser/task-machines.spec.ts`: the setting off and unavailable, a seeded worker card with
      its ready time, and the ready-time list. Screenshot in the PR.
- [ ] `npm run check` passes.

## Not in this package

A real backend (WP-193b). Hivra Cloud's service. MicroVMs. Lending the person's login to a machine (WP-194).
