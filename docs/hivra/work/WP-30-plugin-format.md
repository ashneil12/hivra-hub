# WP-30: Plugin format and registry

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| A | L | none | no |

## Goal

Hivra reads plugins in the open Agent Plugins format, plus a Hivra extension folder, and keeps a registry of what
each installed plugin contributes so it can be turned off or removed cleanly.

## Why

Deep customisation (Ash's vision item 4) without inventing a format: Agent Plugins (`plugin.json`, `skills/`,
`mcp.json`) is an open standard that Codex, Cursor and others read, and pstack already uses it. DeepSeek Harness
shows the rest: every contribution reversible, plugins never trusted to run inside the app. SPEC.md section 7.

## Read first

- The Agent Plugins spec (agent-plugins.org, schema 1.0.0): required `plugin.json` (`$schema`, `name`), optional
  metadata, `skills/<name>/SKILL.md`, `mcp.json` (stdio, streamable-http), reverse-domain folders for
  client-specific extensions. pstack's `plugin.json` is a real example.
- DeepSeek Harness: the plugin kernel's disposer pattern (`docs/cordis-primer.md`) and its package manifest (ideas;
  MIT).
- `src-tauri/src/skills.rs` (already discovers `.agents/skills`, `~/.agents/skills`, each CLI's native skill
  folders and Claude Code plugin caches), `src/features/skills/model/readySkills.ts`,
  `src/features/hub/model/hubMcp.ts` (how sessions get MCP servers), the provider adapters in
  `src/integrations/harness/providers/*`.

## Build

1. **Manifest reader**: parse and validate `plugin.json` against schema 1.0.0; discover `skills/` and `mcp.json`;
   ignore what Hivra doesn't understand, skip a broken skill or server and load the rest (the standard's rule).
2. **Hivra extension folder** (reverse-domain of Hivra's domain; confirm the domain with Ash, use `hivra/` until
   then) with typed contributions: `panels/` (WP-33), `personas/` (WP-23), `monos/` (templates, WP-05),
   `crew-rules.json` (WP-13), `commands/` (slash commands as prompt files). One validator per type.
3. **Registry**: the installed plugins (name, version, source, enabled globally or per project) and every
   contribution each one made, each with a disposer that undoes it. Enable, disable and uninstall run the
   disposers; nothing is left behind (a test lists the file system and config before and after).
4. **Wiring**: skills reach every CLI the way `skills.rs` already finds them (install into a Hivra-managed folder
   it scans, or link into each CLI's skills folder, whichever the CLI reads); MCP servers are added to each
   session's MCP config the way `hubMcp.ts` adds the app's own. Document per CLI what works.
5. Plugins never run code in the app's process. Their code runs only as MCP servers (separate processes) or inside
   the panel sandbox.

## Done when

- [ ] Tests: pstack's real `plugin.json` and skills load; a broken skill is skipped and the rest load; each
      extension type validates; disable and uninstall leave no trace; a Claude Code and a Codex session both see
      an installed skill and MCP server (fake CLIs).
- [ ] `npm run check` passes.
