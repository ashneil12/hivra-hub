# WP-143: A cheap Explore agent for Claude Code crews

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Tonight finds (9 Nov 9pm) | S | none (pairs with WP-89 / WP-141 defaults; does not wait on them) | yes |


## Goal

When Hivra launches a Claude Code session for a Mono or crew worker on Anthropic, the built-in Explore subagent no longer silently inherits the expensive session model. Hivra passes a custom Explore agent pinned to Haiku with Claude Code's `--agents` flag, on that session's own process, so Anthropic's documented cost leak is closed for hub-launched crews. Nothing is written into the project: the first build wrote `.claude/agents/Explore.md` and `Plan.md`, which dirtied every worktree, blocked `hub:ship` and worktree removal, and was committed by crews.

## Why

Anthropic's 9 Nov "which model should you build with" guide (Addy Osmani): the built-in Explore subagent now runs on the session's model unless you define your own Explore with `model: haiku` (or set `CLAUDE_CODE_SUBAGENT_MODEL`). Hivra already sets `CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` via `subagentModelEnv` for bridge workers (`claudeProtocol.ts`, r69), and leaves Anthropic workers alone so Ash's own Haiku pin in settings is not overwritten. That does not guarantee the *named* Explore agent file carries `model: haiku`. Crews that lead on Fable or Opus can burn lead-tier tokens on Explore walks.

## Read first

- `src/integrations/harness/providers/claude/claudeProtocol.ts` (`SUBAGENT_MODEL_ENV`, `subagentModelEnv`)
- `src/integrations/harness/providers/claude/claudeSubagents.r69.test.ts`
- `src-tauri/src/harness.rs` / `model_router.rs` env merge for Claude launches
- Crew / first-mate launch path that creates the worker cwd or project folder
- Anthropic guide (ideas): pin Explore with `model: haiku`. Claude Code's `--agents` flag takes agents as JSON for one session. Do not fetch Ash's live Claude usage. Never write `~/.claude/settings.json`, keys or auth. Settings files are read only for whether an `env` block names a backend (item 3), never for a value.
- `src/features/firstmate/model/checkoutGuard.ts` (`isFirstMate`, `firstMateLaunch`): the pattern `crewLaunch` follows.

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-143-cheap-explore-pin.md`. SOURCES.md row for the Anthropic Explore cost gotcha (ideas). No credits.json unless code is translated from an MIT/Apache source (none required here).
2. **The agent, as a flag.** One `Explore` agent (`description`, `prompt`, `tools`, `model: haiku`), built in code (`explorePin.ts`) and passed as `--agents <json>`. No `Plan` agent: Plan stays on the session model. Tests that the JSON always names a model and has no Plan.
3. **No files, only crew and Mono sessions, only Anthropic, only a CLI that has the flag.** Write nothing into the session folder or `~/.claude`. Pass the flag only when the session is a Mono, a coding team or one of their workers (`crewSession.ts`, the `crew` launch input), only on Anthropic (not the DeepSeek launcher, not a routed Other model), and only when the CLI's `--version` is 2.0.0 or later, where `--agents` began (an older CLI exits on an unknown option and would fail every launch). The version is read once per binary; a version that cannot be read or understood leaves the flag off. A read-only check (`src-tauri/src/explore_agent.rs`) errs toward leaving the flag off:
   - **Never shadow an Explore the person already defined.** `--agents` outranks `.claude/agents`, so the check looks at the Claude config folder the app uses for that session and at `.claude/agents` in the project folder, every folder above it and every folder the session adds with `--add-dir`. A file named `Explore.md`, or one whose frontmatter `name:` is Explore, counts. A frontmatter that does not close in the part read (4 KiB), a first line longer than that, a folder with over 2000 entries, a folder nested deeper than 4 levels and anything it cannot read all count as defined.
   - **Not another backend.** The flag stays off when the process environment, or the `env` block of the session's config-folder `settings.json` or of a `.claude/settings*.json` in the project (the folder or any folder above it), names `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` or `ANTHROPIC_BASE_URL`, where the `haiku` alias is not ours to assume. A settings file is read for the presence of those names only: its values are skipped as it is parsed and are never logged, returned or kept. A settings file that cannot be read or parsed counts as another backend.
   - A check that takes over three seconds starts the session without the flag. Test: `git status` is clean after a launch.
4. **Env stays as today.** Keep `subagentModelEnv` behaviour. This package adds the named agent pin; it does not broaden rewriting of Ash's global settings.
5. **Settings line.** One sentence in the chat when the flag was passed: "Explore uses Haiku so the lead model is not spent on search." It is said once the Claude Code process has started, not before: a launch that failed to start says nothing. It is a keyed status line, so a restart replaces it. Nothing is said when the flag was not passed. No new settings page.
6. **Out of scope.** Do not change WP-10 (lead never edits the project). Do not touch vault or Keychain; the check only reads, and reads no value from a settings file. Do not call Claude subscription APIs.

## Done when

- [ ] A crew or Mono Claude Code session on Anthropic starts with `--agents` naming Explore on `haiku`, and `git status` is clean after the launch.
- [ ] An ordinary chat, a session on the DeepSeek launcher and a session on a routed Other model get no flag.
- [ ] An Explore the person defined (user level, project level or in an added folder) is never shadowed, and an unclosed or oversized frontmatter counts as defined.
- [ ] A CLI older than 2.0.0, or one whose version cannot be read, gets no flag. A session on Bedrock, Vertex, Foundry or another base URL (process environment or a settings file's `env` block) gets no flag.
- [ ] No Plan agent. Nothing is written under the project or `~/.claude`.
- [ ] Tests cover the flag, who gets it and the clean tree; r69 subagent env tests still pass.
- [ ] `node scripts/remove-explore-agent-leftovers.mjs` (dry run; `--yes` deletes) finds the first build's `Explore.md` and `Plan.md` byte for byte, deletes only untracked ones, lists tracked ones for `git rm`, and never touches a file a person edited.

## Licence

Ideas from Anthropic's public model guide (9 Nov 2026). No third-party code to credit. Do not copy Anthropic trademarks into product chrome beyond the model id the CLI already uses.
