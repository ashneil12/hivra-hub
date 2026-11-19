# WP-181a: Machines: every machine on one page, with each CLI's version

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 60 | no |

From PLAN.md, "Ideas from kitze's factory teaser", item 2. Updating a CLI on another machine is
[WP-181b](WP-181b-update-cli-on-another-machine.md). Ideas only, nothing credited.

## Goal

One Machines page shows this Mac, every added host (a VPS, a home server, a Proxmox box: anything added over SSH)
and every paired phone as a card. Under the cards, one table shows each agent CLI against each machine: the version
installed, the latest published one where there is a feed, and "not installed" or "could not ask".

## What Hivra has

- `src-tauri/src/harness_updates.rs`: `npm_package` maps Claude Code, Codex, opencode and Pi to their npm packages;
  `harness_latest_version` reads the npm registry; `harness_update` runs each CLI's own updater (`update_args`) on this
  Mac only. The webview side is `src/features/providers/model/harnessUpdates.ts` and `HarnessUpdateNotice.tsx`.
- `src/features/sessions/model/session.ts` `HARNESSES`: claude, codex, cursor, grok, opencode, pi, omp, fx, hermes,
  antigravity, devin. Gemini is not one of them.
- Added hosts: `remote_machines` and `remote_request` in `src-tauri/src/remote.rs`; the host answers
  `environment.describe` in `host/server.ts` with its name, platform and providers, but no versions.
- Paired phones: `mobile_status` in `src-tauri/src/mobile_access.rs` (device list).
- The Settings health list (`src/features/diagnostics/model/health.ts`, `CliHealth`) already knows installed and
  signed-in for this Mac.

## What to build

1. **Version facts for this Mac.** A command `harness_versions` asks each resolved CLI binary for its version with its
   own `--version` flag (only flags each CLI documents; a CLI with none shows "version unknown"), with a 5-second
   timeout per CLI and no network. Cursor joins the table with its version; it shows "Update in Cursor" because
   there is no updater command for it in `update_args`.
2. **Version facts for a host.** A new host method `providers.versions` in `host/server.ts`, answered the same way on
   the host. The desktop asks it through `remote_request` only when the Machines page is open and the host is
   connected. A host that does not know the method (older version) shows "Update the host to see versions".
3. **The page** (`src/features/machines/`, new): cards for this Mac, each host (name, platform, connected or not,
   last seen) and each paired phone (name, last seen; no CLIs). Then the table: rows are CLIs, columns are machines,
   cells say the version, "latest" when it matches the npm feed, "update available", "not installed" or "could not
   ask". Latest versions come from `harness_latest_version`, cached for an hour, and only for the four npm CLIs.
4. One pure function `versionCell(fact, latest)` decides each cell's words, so the table is tested without machines.
5. The page opens from Settings > Machines and from the existing Add machine flow.

## Rules

- Read-only. Nothing is installed or updated here (that is WP-181b).
- No new outward network call: the npm feed check already exists and keeps its own setting; a host is asked only over
  the SSH connection the person already made.
- No Gemini harness here. A new CLI comes through WP-134's registry design; when it lands, it gets a row.
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists).
- Upstream rules from PLAN.md: the host method is a new case in `host/server.ts`; `remote.rs` gets no new state.

## Done when

- [ ] Red first: a test asks `providers.versions` of the upstream test host and fails; then it answers.
- [ ] `versionCell` tests: same as latest, older, no feed, not installed, timed out, older host.
- [ ] Rust test: `harness_versions` times out per CLI and never reports a timeout as "not installed".
- [ ] Browser spec `tests/browser/machines.spec.ts` with seeded machines: three kinds of card, the table's words, a
      disconnected host shown as such. Screenshot in the PR.
- [ ] `npm run check` passes. A dev-copy check against a real SSH host stays open until done.

## Not in this package

Updating anything (WP-181b). Adding Gemini or any new CLI. Health checks beyond the version. Machine provisioning
(WP-193a).
