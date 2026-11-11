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

## Built (src-tauri/src/team_workspace.rs, tests on a loopback stand-in)

- **Roles and invitations:** owner, admin, member, guest (`allowed`, `authorize`). Invitation links hold a 256-bit
  random token, stored only as a SHA-256 hash, valid 7 days, one use. Nobody invites an owner or someone at their own
  level. Members are removed or re-roled only by someone who outranks them; an owner is never removed.
- **Accept flow over the wire:** `Client::accept` posts the invitation to the shared machine and receives a per-device
  workspace token and a role. `team_workspace_accept` keeps the token in the Keychain, never in `team-workspace.json`.
- **Authenticated payload:** every request after accept carries `Authorization: Bearer <token>`. The server takes the
  person from the token, never from the body. A request with no token is not sent.
- **Off switch:** `sync_outbound` and `Client::from_config` return before any request unless `enabled` is true and
  the endpoint is set. Endpoints must be https (plain http only to the loopback stand-in in tests), with no
  credentials. Redirects are not followed, and only a 2xx answer counts as sent.
- **Settings:** `team_workspace_save` writes the switch and endpoint (a bad endpoint writes nothing). The status
  command reads the file, reads the Keychain only while the switch is on, makes no request, and never shows the token.
- **Private projects:** only shared projects enter a push. A private project's body and id are filtered out before
  serialising.
- **Co-editing (simplified):** documents have a revision. A write names the revision it saw; a stale write gets a
  conflict and the current revision. This is not Yjs and does not merge.
- **Presence:** members check in; anyone with read access lists who checked in.
- **Agents:** an agent acts for one member and inherits that member's role. It reads the shared projects only, and it
  can edit only if the member can. An agent with no membership gets nothing.
- **Stand-in:** the test fixture in `team_workspace_tests.rs` is a loopback server that enforces the same rules. It is
  the contract for the shared machine, not the machine.

## Left (not built, not in this change)

- **Real hosted server:** not built, and not provisioned. The fixture is the only server.
- **Settings switch:** built in Settings > Connections, off by default, with a join form. A browser spec runs on
  chromium and webkit against the real component with a fake IPC.
- **Projects sync (built, projects only):** a save of the `projects` document runs a round while the switch is on, and
  the app polls every 15 seconds. A round pulls shared projects another member made, and merges each field against
  the server revision and this device's last-agreed value (`sync_round`): a local edit is never replaced by a pulled
  value, a field only the other side changed is taken, and a field both sides changed keeps the local value and is
  listed in `conflicts`. The local folder and the shared flag never leave the machine, and a pull never takes the id,
  folder or shared flag. A field the server has no record of (a new server address, or a server that lost the project)
  is sent again, never removed locally; only an explicit removal (`null` at a newer revision) is taken.
- **Share control (built):** "Share with my team" in the project menu sets `shared` on that project, on Ash's click
  only. Unsharing stops syncing and keeps the project locally.
- **Presence (built, list only):** Settings shows "Here now" from the server's presence list while sharing is active.
  No cursors.
- **Tasks and docs (not wired):** the task store (`src-tauri/src/tasks/store.rs`) and the docs store
  (`src-tauri/src/docs.rs`) do not sync. Each has its own tables, revisions and history, so they need their own
  mapping. The field merge runs only on the project record.
- **Agents on the shared board (not wired):** `agent_for` and `agent_board` exist and are tested, but no first mate
  uses them yet.
- **Control-port actions (not added, on purpose):** joining, the switch and sharing a project are the person's taps
  only. Every action in `APP_ACTIONS` (`src-tauri/src/control_cli.rs`) is reachable from agent sessions, so
  `team.join` or `project.share` there would hand those steps to agents; a person-only channel is needed first.
- **Live editing with Yjs, and presence cursors:** not built; the revision check and presence list are the stand-in.
- **Two dev copies on one machine:** not run. The control socket only exposes `app.*` actions, with no way to accept
  an invitation or share a project, and the windows were not driven. The round is proven against the loopback
  fixture, not in two running apps.
- **Token storage:** the token is kept in the Keychain (`monocode-hub:team-workspace`, dev copies `monocode-hub-dev:`).
  Not exercised against the real Keychain by the tests, which use an in-memory store.
- **Invitation delivery:** the link is shown once by whoever makes it; no delivery channel exists.
- **Dependencies:** WP-61 (Hivra Cloud) is not used. The endpoint is a generic placeholder.
