# WP-80: Team workspaces

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E (built off by default; Ash turns it on) | L | 61, 70, 72 | yes |

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

Status: code is built, switched off. Ash's rule (11 Nov): cloud and teams stay off until he turns them on, and no
server, account, domain or spend is created by this package. Nothing sends until he sets both the switch and an
endpoint in `team-workspace.json` (app data folder). Both default to off and empty.

## Built (src-tauri/src/team_workspace.rs)

- **Build 1, roles and invitations:** owner, admin, member, guest (`allowed`, `authorize`). Invitation links hold a
  256-bit random token, stored only as a SHA-256 hash, valid 7 days, one use. Nobody invites an owner or someone at
  their own level. Members are removed or re-roled only by someone who outranks them; an owner is never removed.
- **Build 2, the off switch and sync gate:** `sync_outbound` returns before any transport call unless `enabled` is
  true and the endpoint is non-empty. Endpoints must be https, or http to this machine only, with no credentials.
  Redirects are not followed, and only a 2xx answer counts as sent.
  Only shared projects enter the payload; a private project's body and id are filtered out before serialising.
- **Build 4, scoped board:** `shared_board` lists only shared projects, and only for a member who may read.
- Status for the settings screen: `team_workspace_status` reads the file and makes no network call.

## Left (not built, not in this change)

- **Build 1 storage and sign-in:** the workspace is in memory and tests only. No shared server, no account sign-in,
  no invitation transport. Invitations need an authenticated channel before any real use.
- **Build 2 wiring:** the task and doc stores do not call the sync gate yet. The payload is not authenticated; that
  must be designed with the server.
- **Build 3, live editing:** Yjs co-editing, presence and cursors are not built, and no dependency was added.
- **Build 4 agents:** first mates are not yet scoped to the shared board; only the board filter exists.
- **Settings UI:** the switch is the JSON file, not a toggle. A toggle needs its own browser spec.
- **Dependencies:** WP-61 (Hivra Cloud) is not used. The endpoint is a generic placeholder.
- **Real two-client test:** the local-server test is the module's own rules plus a loopback stand-in for sync; two
  live dev copies on one machine are not run.

## Done when

- [ ] Tests against a local shared server: invite, roles enforced, two clients co-edit a doc, a private project never
      leaves its machine.
- [ ] `npm run check` passes; a check with two dev copies on one machine.
