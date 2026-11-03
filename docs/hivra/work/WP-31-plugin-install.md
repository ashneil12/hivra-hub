# WP-31: Plugin install, update and rollback

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | L | 30 | no |

## Goal

Installing, updating and removing a plugin is safe, pinned and reversible, whoever starts it.

## Why

DeepSeek Harness's plugin manager is the model (SPEC.md section 7): exact versions, a compatibility check before
download, approval before scripts run, approval for any install an agent starts, atomic restore on failure.

## Read first

- DeepSeek Harness's plugin manager, `packages/boot/plugin-manager` (README and install code; ideas, MIT).
- WP-30's registry. `src-tauri/src/portable/` (how the app already stages, checks and restores files safely).

## Build

1. **Sources**: a git URL pinned to a commit or tag, an npm package at an exact version, or a local folder. No
   floating versions.
2. **Before download**: check the plugin's declared platforms and Hivra version range; refuse with a plain reason.
3. **Stage, check, swap**: download into a staging folder, validate with WP-30, then swap in atomically. Any failure
   restores the previous state. A lock file records exactly what is installed.
4. **Scripts**: a plugin that wants to run an install script (or an MCP server that needs `npm install`) shows
   exactly what will run and waits for the person's OK. No script runs silently.
5. **Agent-started installs** (a first mate or Creator mode asking for a plugin) always need the person's OK, shown
   in the Inbox.
6. **Update** to an exact version keeps the old one until the new one validates; **rollback** returns to the
   previous version in one step; **uninstall** runs the disposers and removes the files.

## Done when

- [ ] Tests: pinned install from a local git repo; incompatible platform refused before download; a failing
      validation restores the previous version; a script waits for approval; an agent-started install lands in the
      Inbox; rollback and uninstall leave the lock file and folders exactly as before.
- [ ] Browser spec for the Installed list with update, rollback and remove; `npm run check` passes.
