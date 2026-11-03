# WP-34: Creator mode

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | L | 31, 33 | no |

## Goal

A person asks for a skill, a panel, a persona, a Mono or a slash command, and an agent builds it as a plugin,
installs it live with a preview, and the person keeps it or undoes it.

## Why

Ash: the app should extend itself safely; DeepSeek Harness's Creator mode is the model (the "creator wall" Ash
liked is this). Because plugins are data, MCP servers and sandboxed panels (WP-30), they can be created and
installed in the daily app without changing the app's code, so no ship is needed.

## Read first

- DeepSeek Harness's Creator agent preset and skills, and its design notes
  `.agents/notes/archived/architecture/2026-09-21-creator-skills-progressive-disclosure.md` (ideas; MIT).
- The Hub's self-build pattern: `src-tauri/src/self_build.rs`, `src/features/selfBuild/`, `src/features/hubChange/`
  (worktree per change, preview, apply, undo, watchdog).
- WP-30 to WP-33.

## Build

1. A **Creator** Mono template (WP-05's format) with skills for each contribution type: write it, validate it with
   WP-30, test it (a panel renders in the sandbox, a skill parses, an MCP server answers `tools/list`).
2. Work happens in a scratch plugin folder (the self-build worktree pattern); **Preview** installs it disabled for
   everyone except the current view; **Keep** installs it through WP-31; **Undo** rolls it back; **Discard** removes
   the scratch folder.
3. An MCP server a Creator builds needs the person's OK before it first runs (WP-31's script approval).
4. Changes to Hivra's own code stay out of Creator mode: they go through a dev copy and ship, as CLAUDE.md says.

## Done when

- [ ] Tests: each contribution type created, previewed, kept, undone and discarded with fake models; nothing
      outside the scratch and plugin folders changes.
- [ ] Browser spec of building a panel end to end; `npm run check` passes.
