# WP-16: Retire the Grok bridge

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | M | 01, 22 | no |

## Goal

Claude Code in Hivra is plain Claude Code again. It runs on the person's own Claude login and every surface shows
the model the chat really uses. The `claude-grok` launcher support, the "Grok 4.7" relabelling and the r61 rule that
rewrites stored Claude models to Grok are gone.

## Why

Ash, 3 Nov: "we dont need the grok bridge atm so it can go". The bridge was built for a Mac with no Claude
subscription (27 Oct). It hooks 22 upstream files (model picker, pill, cards, tab, turn header, usage chip), so
every upstream merge pays for it, and a public product shouldn't rename one vendor's models to another's.

## Read first

- `src/integrations/harness/providers/claude/claudeGrokBridge.ts`: detection by the CLI path's file name, every
  label, `grokBridgeEffort`, `ranModel`.
- `src/features/sessions/model/bridgeModels.ts`: the ids `claude:grok-4.7` and `claude:deepseek-v4.1-flash`,
  `MONO_BRIDGE_MODEL_ID`, `WORKER_BRIDGE_MODEL_ID`, and r61's `bridgeSafeModel` (any stored Claude model reads as
  Grok 4.7).
- `src-tauri/src/harness.rs`: `CLAUDE_GROK_BRIDGE_NAME`, `harness_claude_grok_bridge`, and `claude-grok` accepted as
  Claude Code's CLI name in `resolve_harness_binary_override_with`. `src-tauri/src/verify_live.rs`: the bench plan's
  `grok` flag. `src-tauri/src/mcp_server.rs`: the delegate tool's `model` description.
- `src/features/settings/ui/SettingsView.tsx`: "Claude Code runs on" and the Grok note under the model picker.
- `src/features/providers/model/providerBinaryPaths.ts`: where the CLI path is stored
  (`monocode.providerBinaryPaths.v1`).
- Monos and workers: `src/features/monos/model/monoModels.ts`, `src/features/hub/model/` (`builtInMonos`, `hubLeads`,
  `hubTeam`, `hubTeams`, `hubChecker`, `codingTeamModel`), `src/features/agent-app/model/` (`agentApp`,
  `agentAppTasks`, `taskDifficulty`).
- The real bench: `scripts/hub-realtest.mjs` (`--agents grok-sub`), `scripts/realconv/llm.mjs`, `docs/REALTEST.md`,
  `docs/REALCONV.md`.
- Everything else (87 files on 3 Nov):
  `rg -l 'claudeGrokBridge|bridgeModels|claude-grok|GROK_BRIDGE|MONO_BRIDGE|claudeRunsOnGrok|onGrokBridge|chatOnGrokBridge|modelInUseLabel|shownModelName|claudePillName|grokBridgeEffort|ranModel|bridgeSafeModel|grok-sub|grok-4\.7' src src-tauri scripts tests docs`

## Keep

- Upstream's Grok CLI harness (`src/integrations/harness/providers/grok`, the `grok` CLI in `harness.rs`).
- Other models through the app's router (`model_router.rs`, `customModels.ts`, every provider including `xai`).
  WP-22's auto mode uses it.
- The DeepSeek launcher (`claude-deepseek`) and DeepSeek workers, because the real bench runs on it. Keep
  `claudeRunsOnSubscriptionBridge` for it (rename it if that reads better). If Ash says it should go too, it goes in
  this package the same way.

## Build

1. **Inventory** the search hits in the PR description in three groups: delete (Grok only), simplify (a label or
   model that now passes through unchanged) and keep (DeepSeek, router).
2. **Remove the Grok launcher:** its detection, the `harness_claude_grok_bridge` command and its registration, the
   `claude-grok` CLI name, the Settings choice and note, the effort mapping, the bench's `grok` plan and
   `--agents grok-sub`.
3. **Real names everywhere.** Every surface that showed "Grok 4.7" for a Claude Code chat shows the chat's own model
   again: model picker and menu, pill, card and hover preview, tab, turn header, Mono model line, usage chip,
   worker names, completion titles. Where a hook in an upstream file existed only for the bridge, restore upstream's
   code (`git diff upstream/main -- <file>`).
4. **Monos.** Monos, Leads, the Checker and new teams get the app's default Claude model instead of
   `MONO_BRIDGE_MODEL_ID`. Drop `bridgeSafeModel` and the Mono model fixes that turn Claude models into Grok.
5. **Migrate once**, on the first start after this change:
   - A Claude CLI path whose file name is `claude-grok` is cleared, so Claude Code runs as `claude`. Otherwise the
     launcher would keep running Grok under Claude names. Show a one-time note: "Claude Code now runs on your Claude
     login. The Grok launcher isn't used any more."
   - A stored `claude:grok-4.7` (chats, Monos, Leads, defaults, the last model, delegation rows) reads as the app's
     default Claude model.
   - `claude:deepseek-v4.1-flash` and a `claude-deepseek` path are left alone.
6. **Tests.** Delete the specs and unit tests that only proved bridge naming (`tests/browser/pm-bridge-names.spec.ts`,
   `tests/browser/model-picker-bridge.*`, `ModelPicker.grok.test.ts`, `claudeGrokBridge.test.ts`,
   `noAnthropicDefault.r61.test.ts` and the like). Where a test also proves something else, keep that part. Add tests
   for the migration.
7. **Archive.** The last commit that still has the bridge gets the tag `archive/grok-bridge`. Cloud containers can't
   push tags, so put the exact command in the PR for Ash:
   `git push origin <sha>:refs/tags/archive/grok-bridge`.
8. Update the docs that describe the bridge (`docs/REALTEST.md`, `docs/REALCONV.md`, `docs/PORTABLE.md`,
   `src/features/hub/HANDOFF.md`).

## Don't

- Don't touch the launcher, its gateway or Ash's Grok sign-in on his Mac.
- Don't remove upstream's Grok harness or the router's `xai` provider.
- Don't start before WP-01 (#11) and WP-22 (#8) merge: they change the same specs and model code. WP-05 and WP-13
  start after this lands, because they change Mono models and worker routing.

## Done when

- [ ] The search above finds nothing outside the migration, the DeepSeek launcher and their tests.
- [ ] Migration tests: a `claude-grok` path is cleared and the note shows once; a stored `claude:grok-4.7` reads as
      the default Claude model; DeepSeek ids and the `claude-deepseek` path are untouched.
- [ ] The PR lists the upstream files that match upstream again (`git diff --stat upstream/main`), and no upstream
      file moved further from it.
- [ ] `npm run check` passes, and the browser job fails only main's known tests.
- [ ] Ship note in the PR: after shipping, Claude Code chats use Ash's Claude login and show their real model names.
- [ ] Mac check in a dev copy: with Claude Code's CLI path set to `~/.local/bin/claude-grok` on main's build, start
      this branch's build. The path is cleared, the note shows once, and a new chat and a Mono show Claude model
      names and run.
