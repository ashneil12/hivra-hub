# WP-143: Pin a cheap Explore (and Plan) agent for Claude Code crews

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Tonight finds (9 Nov 9pm) | S | none (pairs with WP-89 / WP-141 defaults; does not wait on them) | yes |


## Goal

When Hivra launches a Claude Code session for a Mono or crew worker, the built-in Explore (and Plan) subagent no longer silently inherits the expensive session model. Hivra ships or writes a project-local custom Explore agent pinned to a cheap model (Haiku by default on Anthropic; the worker's own cheap model off Anthropic), so Anthropic's documented cost leak is closed for hub-launched crews.

## Why

Anthropic's 9 Nov "which model should you build with" guide (Addy Osmani): the built-in Explore subagent now runs on the session's model unless you define your own Explore with `model: haiku` (or set `CLAUDE_CODE_SUBAGENT_MODEL`). Hivra already sets `CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` via `subagentModelEnv` for bridge workers (`claudeProtocol.ts`, r69), and leaves Anthropic workers alone so Ash's own Haiku pin in settings is not overwritten. That does not guarantee the *named* Explore agent file carries `model: haiku`. Crews that lead on Fable or Opus can burn lead-tier tokens on Explore walks.

## Read first

- `src/integrations/harness/providers/claude/claudeProtocol.ts` (`SUBAGENT_MODEL_ENV`, `subagentModelEnv`)
- `src/integrations/harness/providers/claude/claudeSubagents.r69.test.ts`
- `src-tauri/src/harness.rs` / `model_router.rs` env merge for Claude launches
- Crew / first-mate launch path that creates the worker cwd or project folder
- Anthropic guide (ideas): pin Explore with `model: haiku`. Do not fetch Ash's live Claude usage. Do not read or write `~/.claude/settings.json`, keys or auth.

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-143-cheap-explore-pin.md`. SOURCES.md row for the Anthropic Explore cost gotcha (ideas). No credits.json unless code is translated from an MIT/Apache source (none required here).
2. **Agent file content.** A checked-in template (under `src/` or `docs/hivra/templates/`, builder chooses the existing pattern for seeded agent files) for `Explore.md` (and optionally `Plan.md`) with frontmatter `name: Explore` and `model: haiku` (or the resolved cheap worker model id when the session is off Anthropic). Keep the body short: read-only explore, no edits. Tests that the template always names a model field.
3. **Write into the launch cwd only.** When starting a Claude Code harness session for a hub Mono or crew worker, ensure `.claude/agents/Explore.md` exists in that session's project / worktree cwd from the template if missing. Never overwrite a person's custom Explore that already sets `model:`. Never write into `~/.claude/agents`. Tests with a temp cwd: missing file is created; existing custom with model is left alone; existing without model is upgraded once (or left alone with a WP comment if safer; prefer leave-alone for any existing file).
4. **Env stays as today.** Keep `subagentModelEnv` behaviour. This package adds the named agent pin; it does not broaden rewriting of Ash's global settings.
5. **Settings line.** One sentence in Crew Defaults or the worker start card when the pin applied: "Explore uses Haiku so the lead model is not spent on search." No new settings page required if a start-card line is enough.
6. **Out of scope.** Do not change WP-10 (lead never edits the project) beyond writing the agent file into the worker checkout. Do not touch vault, Keychain, or `~/.claude` config. Do not call Claude subscription APIs.

## Done when

- [ ] A fresh Claude Code crew cwd gets `.claude/agents/Explore.md` with an explicit cheap `model:`.
- [ ] An existing custom Explore with a model field is never overwritten.
- [ ] Nothing is written under `~/.claude`.
- [ ] Tests cover create / leave-alone; r69 subagent env tests still pass.

## Licence

Ideas from Anthropic's public model guide (9 Nov 2026). No third-party code to credit. Do not copy Anthropic trademarks into product chrome beyond the model id the CLI already uses.
