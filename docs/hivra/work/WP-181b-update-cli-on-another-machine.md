# WP-181b: Update a CLI on another machine

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | S | 181a, 60 | no |

From PLAN.md, "Ideas from kitze's factory teaser", item 2 (one-click Update on another machine). Ideas only, nothing
credited.

## Goal

On the Machines page, a cell that says "update available" for an added host has an Update button. One tap, one
confirmation naming the machine and the CLI, and the host runs that CLI's own updater. The cell then shows the new
version or the updater's last line in plain words.

## What Hivra has

- `harness_update` in `src-tauri/src/harness_updates.rs` runs a CLI's own updater on this Mac: it checks
  `provider_start_allowed`, refuses a binary that is not the resolved harness (`is_resolved_harness_binary`), closes
  stdin so an updater that asks fails instead of hanging, times out at 5 minutes and treats "exit 0 but printed a
  failure" as a failure (`reports_failure`, `update_failure`).
- WP-181a's `providers.versions` host method and the Machines page.
- The host runs commands for the desktop already (`workspace.run`, `git.action` in `host/server.ts`), each through
  the host's own process helpers (`host/process.ts`).

## What to build

1. **A host method `providers.update`** that takes only a CLI id. The host maps the id to the same updater arguments
   as `update_args` (one shared table: move `update_args` into a JSON file both sides read, so they cannot drift),
   resolves the binary itself, and runs it with stdin closed and a 5-minute timeout. It never takes a path, an
   argument list or a shell string from the caller.
2. **One update at a time per host.** A second request while one runs answers "busy" (the WP-60 typed error
   envelope when it has landed), never a second updater.
3. **Desktop side.** The Update button in a WP-181a cell calls `remote_request` with `providers.update`. A
   confirmation says: "Update Codex on build-box? It runs `codex update` there." Afterwards the cell re-reads
   `providers.versions`. A failure shows the updater's last line, scrubbed of secrets.
4. **Activity log** (WP-78): one line per update, who asked, which machine, which CLI, the result.

## Rules

- Off by default: Settings > Machines > "Allow updating CLIs on added machines". When off, the button is not shown.
- The person's tap is required every time. No agent, habit, automation or lead tick can call `providers.update`;
  the control path and `app` actions do not expose it.
- Only CLIs with an entry in the shared updater table. Cursor, Grok and the rest show "Update it on that machine".
- No new outward call from the desktop; the host's updater reaches its own release feed, as it would if the person
  ran it by hand.
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists).
- Upstream rules from PLAN.md: a new case in `host/server.ts`; `harness_updates.rs` keeps its behaviour.

## Done when

- [ ] Red first: a host test calls `providers.update` with an unknown id, a path and extra arguments; each is refused
      (the first test fails before the method exists).
- [ ] Host tests with a fake updater: success, exit 0 with a failure line, timeout, a second call while busy.
- [ ] Test: the shared updater table gives the same arguments on both sides.
- [ ] Test: with the setting off the desktop sends nothing; the control CLI has no route to it.
- [ ] Browser spec `tests/browser/machines-update.spec.ts`: the button appears only with the setting on, the
      confirmation names the machine and command, and a seeded failure shows its line. Screenshot in the PR.
- [ ] `npm run check` passes. A dev-copy check on a real SSH host stays open until done.

## Not in this package

Installing a CLI that is missing. Updating the host package itself. Updating anything on a phone.
