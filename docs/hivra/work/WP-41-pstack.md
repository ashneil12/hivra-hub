# WP-41: pstack in every chat

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | S | 30 | yes |

## Goal

pstack is installed by default and its skills reach every first mate and worker, on every CLI that reads skills.

## Why

Ash chose pstack (Lauren Tan's skills for rigor and verification, MIT) to ship in every chat. It is already an
Agent Plugins package, so it installs as-is.

## Read first

- pstack (`cursor/plugins`, folder `pstack`): `plugin.json` (schema 1.0.0, version 0.15.36 at the time of
  writing), 58 skills, `agents/`, `automations/`, `LICENSE` (MIT).
- WP-30 and WP-31.

## Build

1. Add pstack to the default plugin set, pinned to a commit of `cursor/plugins`, installed through WP-31 on first
   start (and on existing installs once), enabled globally.
2. Its `agents/` and `automations/` folders are Cursor-specific: ignore them unless a CLI can use them, and say so in
   the PR.
3. Credit pstack in `NOTICE` and the Credits view (WP-08).
4. A person can turn it off like any plugin.

## Done when

- [ ] Tests: a fresh install has pstack enabled; a Claude Code and a Codex worker session see its skills (fake
      CLIs); disabling removes them.
- [ ] `npm run check` passes.
