# WP-87: Each worktree runs its own copy of the project without clashes

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| G | M | 82 | yes |

## Goal

When several crews work on one project at once, each one can start the project's dev server and services in its own
worktree without fighting over ports, containers or local URLs. Hivra already does this for its own dev copies (one
slot, port and data folder per worktree); this package does it for any project.

## Why

Ash, 4 Nov: shared [HumanLayer](https://github.com/humanlayer/humanlayer) (Apache-2.0). Its `apps/devstack` gives every
worktree a full local stack: a stable id from the worktree, a block of free ports, a Docker Compose project of its
own, an env block written for that stack, readiness checks, `status` and `down`, and a sweep of stacks whose worktree
is gone. With WP-82's pool, a crew's slot can keep its stack between leases.

**What it replaces:** for Hivra itself, nothing (`npm run hub:dev` keeps its own slots). For other projects, it
replaces a crew guessing a free port.

## Read first

- HumanLayer: `apps/devstack/src/lib/` (`stack-id.ts`, `ports.ts`, `env-block.ts`, `compose.ts`, `manifest.ts`,
  `registry.ts`, `status.ts`, `down.ts`, `routes.ts`, `workspace-config.ts`), `src/environment/`
  (`available-ports-probe.ts`, `process-runner.ts`) and `src/cli.ts`, with their tests. Leave out what is specific to
  HumanLayer's own services (WorkOS, MinIO, Redis, Postgres seeding).
- Hivra: `scripts/hub-dev.mjs` (slot names, the port grid, refusing a clash), `.monocode/project.json` actions,
  WP-82 (the pool and `return`), `src-tauri/src/worktree_janitor.rs`.

## Build

1. **Copy the generic parts** of devstack with its Apache-2.0 `LICENSE`, a `NOTICE` entry and credits.json: the stack
   id, port blocks, the env block, Compose project names, the registry, status and down.
2. **A project declares its stack** in its project file: the services, which ports each needs, and the env names that
   carry them (for example `PORT`, `VITE_PORT`, `DATABASE_URL`). A project with no stack declared is unaffected.
3. **Per worktree.** Starting the project in a worktree gives it a stable stack id and a port block, writes the env
   block to a gitignored file, and starts the services under that stack's Compose project. `status` and `down` work
   per stack, and the task card links the running app's local URL.
4. **With the pool.** When WP-82 returns a slot, its stack is stopped first. A stack whose worktree is gone is listed
   in Clean up and removed only with Ash's tap.
5. **No Docker** is fine: a stack without Compose services only gets its ports and env block.
6. **Dev copies** use their own registry and port range, and tests use a stand-in for Docker.

## Done when

- [ ] Tests (ported from devstack's where it has them):
  - two worktrees of one project get different ports and Compose names;
  - the same worktree gets the same stack id again;
  - `down` stops only its own stack;
  - returning a pool slot stops its stack;
  - a stale stack shows in Clean up and isn't removed without a tap;
  - a project with no stack declared is unchanged.
- [ ] `npm run check` passes.
