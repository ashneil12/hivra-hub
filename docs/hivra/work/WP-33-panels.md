# WP-33: Pages become panel plugins

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | M | 04, 31 | no |

## Goal

The Hub's Pages become panels: a plugin contribution type, rendered in the same sandbox, stored locally, opened as
tabs.

## Why

The Pages sandbox and permission bridge are the strongest part of the Hub's dashboards; the Ash OS build path is
not (SPEC.md sections 7 and 11).

## Read first

- `src/features/pages/model/` (`pageSpec.ts`, `sandbox.ts`, `pageBridgeHost.ts`, `pageGrants.ts`, ready pages
  seed), `src-tauri/src/page_http.rs`, `src-tauri/src/page_frames.rs`, `docs/pages-build-contract.md`.
- WP-04 (where Pages' storage moved), WP-30 (`panels/` contribution), WP-31.

## Build

1. A panel contribution is the existing PageSpec (blocks or bespoke HTML, CSS and JS) plus its permission list, in
   a plugin's `panels/` folder.
2. The sandbox, CSP, bridge and grants stay exactly as they are. The bridge's data calls (`tasks`, `project`,
   `agents`, `jobs`) read from local records (delegations, projects) instead of Ash OS.
3. A person's existing kept Pages become panels in a local "My panels" plugin, so they can be edited, exported and
   rolled back like any plugin.
4. Building a panel from a prompt goes through Creator mode (WP-34); the Ash OS `build-page` call is gone.

## Done when

- [ ] Tests: a panel from a plugin renders in the sandbox with only its granted permissions; existing Pages migrate
      into "My panels"; disabling the plugin removes the panel tab.
- [ ] The existing Pages tests still pass (moved, not dropped); `npm run check` passes.
