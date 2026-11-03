# WP-32: Discover

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | M | 30 | yes |

## Goal

A Discover tab that lists plugins from static indexes, shows what each one adds and its licence, and installs with
WP-31. Listing never runs plugin code.

## Why

DeepSeek Harness's Discover and its static market index (SPEC.md section 7). Reading existing indexes means Hivra
users see plugins people already publish, with credit to their authors.

## Read first

- DeepSeek Harness's plugin market index format and generator (`packages/util/plugin-market-index`,
  `apps/plugin-market-generator`; MIT, the validator may be vendored with credit).
- Claude Code plugin marketplaces (`.claude-plugin/marketplace.json`): which parts are portable (skills, MCP
  servers).
- WP-30's manifest reader, WP-31's installer.

## Build

1. **Hivra index format**: a JSON list of entries (name, description, version, pinned source, licence, platforms,
   author, a summary of contributions). Keep it a superset that DeepSeek Harness-format entries map into.
2. **Readers** for the Hivra index, DeepSeek Harness indexes and Claude Code marketplaces. An entry whose content
   Hivra can't use (a DeepSeek Harness plugin that only runs inside DSH's own agent loop) is shown as not
   compatible, never offered for install.
3. **Index sources** are a list in Settings; the default is one index file in this repo (`plugins/index.json`) that
   starts with pstack, e2e, Browser, Desktop control and Council personas.
4. **Discover UI** in Settings > Plugins: search, filter by what a plugin adds, a detail view with licence, source,
   contributions and permissions, and Install (WP-31).

## Done when

- [ ] Tests: each reader maps sample entries; incompatible entries are marked; listing never executes anything
      (asserted).
- [ ] Browser spec with screenshots; `npm run check` passes.
