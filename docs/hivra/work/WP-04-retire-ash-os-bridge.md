# WP-04: Retire the Ash OS bridge

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| A | L | none | no |

## Goal

Hivra runs with no outside service. Everything the app still needs from Ash OS lives in the app's own storage, and
the bridge, its stubs and its live proxy are gone.

## Why

Hivra is an open-source product; it can't depend on Ash's personal Python service (`exo-cc-studio`, port 18767),
which has been unreliable. SPEC.md section 11 retires it.

## Read first

- `src-tauri/src/hub.rs` (the bridge: forwards `ash-hub-*` actions to 127.0.0.1 with a token, plus an SSE feed).
- `src/features/hub/model/hubData.ts` and every caller of an `ash-hub-*` action (about 34 actions in 10 files:
  `rg '"ash-hub-' src`).
- `src/features/hub/model/hubMcp.ts` (the `ash-os` MCP entry every hub chat gets), `ash_recall` / `ash_remember`.
- `scripts/hub-stub-server.mjs`, `scripts/hub-stub-studio.mjs`, `scripts/hub-stub-ash-os-mcp.mjs`,
  `scripts/hub-dev.mjs` (`--hub stub|live|off`, the read-only live proxy), CLAUDE.md "Which copy is which".

## Build

1. **Inventory** every `ash-hub-*` action and sort it in the PR description:
   - **move local**: projects and their Monos (`projects`, `project-create/rename/archive`, `mono-project-add/remove`):
     use upstream's own projects store plus a small local table for Hivra-only fields; Pages (`pages`, `page-update`,
     `page-remove`): local storage that WP-33 will own; layout.
   - **replace**: needs, questions, answers, jobs, checks (`needs`, `need-*`, `question`, `answer`, `jobs`, `job-*`,
     `checks`, `check-delivered`): these are delegation records and decisions; read them from `delegations.rs` now
     and leave a clear seam for WP-14's decision store.
   - **drop**: the Today ledger, `since`, `events`, `older-dismiss`, `verify-messages`, `memory-primer`, `active`,
     `build-page`, the `change-*` calls (self-build keeps its own local worktree flow).
2. Move the data a person already has: on first start after this change, if a reachable Ash OS answers, offer a
   one-time import of projects and kept Pages into local storage (dev copies import from the stub). If it doesn't
   answer, start clean. Never write back to Ash OS.
3. Remove `hub.rs`, the `ash-os` MCP entry, the stubs, the live proxy and `--hub` from `hub:dev`; update CLAUDE.md
   and `scripts/hub-dev-loop.test.cjs` in the same PR.
4. Screens that only showed Ash OS data (Today, Being built, Needs you) show empty states until WP-06 removes them.
5. Tag the last commit with the bridge as `archive/ash-os-bridge`.

## Don't

- Don't touch Ash's real Ash OS or its data. Prove the import with the stub under a temporary HOME.
- Don't remove anything WP-06 owns (the screens themselves); only cut their data source.

## Done when

- [ ] `rg 'ash-hub-|ash-os|18767|MONOCODE_HUB_PORT' src src-tauri scripts` finds nothing outside the import and
      tests for it.
- [ ] Projects, Monos per project and Pages survive a restart in local storage (tests).
- [ ] The one-time import works against the stub under a temporary HOME (test).
- [ ] `npm run check` passes; a dev copy starts with no Ash OS running.
