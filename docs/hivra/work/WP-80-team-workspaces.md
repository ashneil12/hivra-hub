# WP-80: Team workspaces

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E (start when Ash says) | L | 61, 70, 72 | yes |

## Goal

A project's board and docs can be shared with other people, with roles and invitations, and docs can be edited by
several people at once.

## Why

Ash, 4 Nov: liked Orbit's team collaboration. Hivra runs on one person's computer, so sharing needs a place everyone
can reach. That is a Hivra Cloud machine (WP-61) or a self-hosted Hivra server. This package waits for it.

## Read first

- Orbit `apps/server/src/repositories/workspaces.rs`, `membership.rs`, `teamspaces.rs`, invitations and roles,
  `apps/server/src/collab/` (the Yjs update log is the source of truth; rooms per open page), `live/` (presence),
  `docs/operations.md` "Orbit Cloud" (one database, many servers, isolation per workspace, per-workspace job
  limits).
- WP-60, WP-61, WP-70, WP-72.

## Build

1. **Workspace on the shared machine**: members, roles (owner, admin, member, guest), invitations by link.
2. **Sync**: a shared project's tasks and docs live on the shared machine. Each member's app reads and writes them
   there, and private projects stay local.
3. **Live editing**: docs and task descriptions co-edited with Yjs, with presence and cursors (Orbit's collab).
4. **Agents**: each member's first mates see the shared board like their own and stay scoped to it.

This package is planned only. Ash decides when it starts, after WP-61.

## Done when

- [ ] Tests against a local shared server: invite, roles enforced, two clients co-edit a doc, a private project never
      leaves its machine.
- [ ] `npm run check` passes; a check with two dev copies on one machine.
