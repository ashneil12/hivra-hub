# WP-193b: A machine per task on an added host, with warm slots

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | L | 193a, 60, 82 | no |

From PLAN.md, "From Aether", item 1 (the first real machine backend and warm slots). Ideas only, nothing credited.

## Goal

On a Linux host the person already added (a VPS, a home server), each task can run in its own fresh container, made
from a prepared copy of the project so it is ready in seconds, and removed when the task is done. A few prepared
copies are kept warm so the wait is the container start, not an install.

## What Hivra has

- WP-193a: the lifecycle rules (`nextStep`), the `MachineBackend` interface, `task_machines` records and the ready-time
  measure.
- The host (`host/`): owns provider processes and session records (WP-60), runs commands for the desktop
  (`workspace.run`, `git.worktreeCreate` in `host/server.ts`), keeps its own records under its data folder.
- The worktree pool idea (WP-82): prepared checkouts with installs and build cache, never handing out a dirty or
  leased one.
- WP-87's stacks (`src-tauri/src/stacks.rs`): a stable id and a block of ports per worktree.

## What to build

1. **A `container` backend on the host** (`host/machines/`, new). It uses rootless Podman, or Docker when Podman is
   absent, only if one is already installed for the host user; it never installs either. `environment.describe`
   reports which one is present, and the desktop offers the backend only then.
2. **A prepared image per project:** made on the host from the project's checkout with its setup action
   (`.monocode/project.json`'s Setup, only after the person imported it, the same trust rule as actions), tagged with
   the commit and the lockfile hash, and rebuilt when either changes. Build output stays on the host.
3. **Warm slots.** Up to N stopped containers from the current image (default 2, a setting, 0 turns it off). A task
   takes a warm slot, checks out its branch, and starts; a new slot is prepared behind it. A slot older than its image
   is removed, never handed out.
4. **The lifecycle actions** map to the engine: provision = take a slot or create a container, suspend =
   `pause`, resume = `unpause`, destroy = `rm` after the backend checks for unpushed commits and running turns. The
   container has the worktree, the provider CLI the host already has, no host home folder mounted, and no Docker
   socket. Its network follows the engine's default; the brief does not open ports to it beyond WP-87's block.
5. **Ready time** is measured from "take a slot" to the provider CLI answering inside it, and recorded per 193a. The
   PR gives the measured median for a small project on a real host, warm and cold.

## Rules

- Off by default per host: "Run tasks in containers on build-box". With it off, nothing is built or started.
- Spends nothing: it uses the person's own host; no cloud call, no paid service.
- No credentials are copied into an image or a container. The provider login stays the host user's (WP-194 is the
  separate, opt-in way to lend one for a session).
- Never mounts the host home, SSH keys or the container engine's socket into a container.
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists).
- Upstream rules from PLAN.md: new host module; `host/server.ts` gets new cases only.

## Done when

- [ ] Red first: a host test with a fake engine CLI expects `provision` to take a warm slot and fails before the backend
      exists.
- [ ] Tests with the fake engine: a stale slot is removed, not used; destroy refuses with unpushed commits; no home
      mount and no socket in the create arguments; setup runs only after import; slots refill to N.
- [ ] Test: with Podman and Docker both absent the backend is not offered.
- [ ] Browser spec `tests/browser/host-containers.spec.ts`: the per-host setting, shown only when an engine is
      reported. Screenshot in the PR.
- [ ] `npm run check` passes. A run on a real Linux host with Podman, with measured ready times, stays open until done.

## Not in this package

MicroVMs (they need KVM and root on the host; a later backend can plug into 193a's interface). macOS or Windows hosts.
Hivra Cloud machines (needs WP-61's service).
