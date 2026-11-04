# WP-79: A safe door for outside AI tools

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | L | 70, 72 | yes |

## Goal

AI tools outside Hivra (Claude Code, Codex, Grok or Claude Desktop on the same computer) can connect to Hivra over
MCP and read the projects, tasks, docs and current agent work that the person allows, read-only by default. The person
can disconnect any of them in one click.

## Why

Orbit serves an MCP endpoint with its own OAuth server: per-project grants, short tokens, rotation and one-click
revoke (Apache-2.0). It is a careful, tested design. Hivra's existing `monocode mcp` serves only the app's own agents.

## Read first

- Orbit `docs/mcp.md` (all of it), `apps/server/src/mcp.rs`, `oauth.rs`, and the tests `oauth_api`, `mcp_api` and
  `http_security`. Its pins: the official Rust MCP SDK and `oxide-auth` for PKCE.
- Hivra's control port and `monocode mcp` (CLAUDE.md "Which copy is which": a dev copy only reaches its own port),
  WP-70, WP-72.

## Build

1. **Off by default.** Settings → Connected apps → "Let AI tools on this computer read Hivra" starts an MCP endpoint
   on loopback only (`http://127.0.0.1:<port>/mcp`, Streamable HTTP). A dev copy uses its own port and never the
   daily app's.
2. **OAuth 2.1 with PKCE**, as Orbit does it: dynamic client registration for public clients, loopback callbacks,
   a consent page in the app (pick projects, then read-only, or read plus task writes), 15-minute access tokens,
   30-day refresh tokens that rotate, reuse of a used refresh token revokes the connection, and codes valid one
   minute and once. Tokens and codes are stored only as hashes.
3. **Tools**: `list_projects`, `list_tasks`, `get_task`, `list_docs`, `get_doc`, `current_work` (what each first mate
   is doing), and with the write grant, `create_task` and `update_task` with the version they read. Results never
   include anything outside the grant. Text is marked as data, not instructions.
4. **Connected apps** list: each client, what it may see, last used, Disconnect. Every connect and disconnect goes to
   the activity log (WP-78).
5. Remote clients (through Hivra Cloud or a tunnel) are out of scope until WP-61.

Translate Orbit's Rust (axum and sqlx) to Hivra's server and rusqlite, keeping its security checks and tests, with
credit.

## Done when

- [ ] Tests ported from Orbit: the full flow with PKCE, a project outside the grant refused with no content, revoke
      gives 401, refresh rotation and reuse revokes, code reuse refused, Origin and Host checks, body limit.
- [ ] `npm run check` passes; a dev-copy check: `claude mcp add` against the dev copy, list tasks, disconnect.
