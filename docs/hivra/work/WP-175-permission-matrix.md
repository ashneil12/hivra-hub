# WP-175: One permission mode matrix for every CLI, pinned by tests

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Wave K (from the 10 Nov source watch) | S | none. Do not edit the approval paths WP-146 owns | yes |

## Goal

A session's permission mode comes from one written matrix. Each CLI adapter maps Hivra's four modes in one place, the order in which a mode is chosen is fixed and tested, and a refused mode change means the same thing on every CLI.

## Why

Happy's permission-resolution doc (MIT, `docs/permission-resolution.md`) sets out one resolution order for a session's mode and one mapping per CLI. Hivra already has most of the parts. `runtimeModeToPermission` in `src/integrations/harness/providers/claude/claudeProtocol.ts` sends `default` for Supervised on purpose, so a session the picker calls Supervised cannot fall back to the user's own `defaultMode`. `antigravityModeId` and the `applyRuntimeMode` functions in `devin`, `antigravity` and `fx` do the same job for the other CLIs. Bypass on Claude restarts the process when it cannot be switched live (`claudeLaunch.ts`).

What is missing:

- No single place says which Hivra mode maps to which CLI setting. The mapping lives in four files.
- A refused mode change is handled three ways. Antigravity and Devin await the request with no catch, so a refused change stops the turn. `fx` catches an unsupported `set_mode` and leans on `handlePermission` as a backstop. Nothing pins this across CLIs.
- Plan handling differs. Antigravity maps planning to `default`, `fx` maps it to `ask`, and Claude's `runtimeModeToPermission` never returns `plan`.
- No test pins the order in which a session's mode is chosen (state in memory, saved state, the phone's payload, then the default).

## What not to take from Happy

- Happy's `read-only` and `safe-yolo` values. Hivra has no need for them yet; plan handling covers the read-only case.
- Happy's sandbox fallback, which forces `bypassPermissions` when a sandbox flag is on. Hivra has no such flag, and adding one would widen permissions, the reverse of failing closed.
- Happy's shared wire package. Not needed until a real schema drift bug shows up.

## Licence

Happy is MIT, `Copyright (c) 2026 Happy Coder Contributors`. This package ports the idea and writes Hivra's own matrix in Hivra's words. If any Happy text or code is copied later, keep its MIT notice in `NOTICE` and add a line to `credits.json`.

## Read first

- Happy `docs/permission-resolution.md` (the idea only).
- `src/integrations/harness/providers/claude/claudeProtocol.ts` (`runtimeModeToPermission`, `buildClaudeSpawnArgs`).
- `src/integrations/harness/providers/claude/claudeLaunch.ts` (live mode switch and restart).
- `src/integrations/harness/providers/antigravity/antigravityProtocol.ts` (`antigravityModeId`), and `devin/devin.ts`, `antigravity/antigravity.ts`, `fx/fx.ts` (`applyRuntimeMode`).
- `src/features/sessions/model/session.ts` (`RuntimeMode`).
- WP-146 for the rule that an open approval blocks carry-on.

## Build

1. Add `src/integrations/harness/core/permissionMatrix.ts`. It holds one table: each Hivra mode (`supervised`, `auto-accept-edits`, `auto`, `full-access`) against each CLI's setting, plus the planning row for each CLI.
2. Replace each adapter's mapping function with a lookup into that table. Keep the Claude flags (`--permission-mode`, `--allow-dangerously-skip-permissions`) exactly as they are today.
3. One rule for a refused mode change, applied to every CLI. A refused downgrade (to a less permissive mode) ends the turn as waiting, in plain words, and never continues on the old mode. A refused upgrade keeps the current mode and says so. `fx` moves to the same rule.
4. Pin the resolution order in one function: the session's live mode, then its saved mode, then the phone or server payload, then `supervised`. There is no sandbox step.
5. Tests: one table test per adapter that pins the mapping. A test that a Supervised session never sends bypass. A fixture per CLI where `set_mode` is refused, showing the turn stops or keeps its mode as the rule says.

## Out of scope

- Approval cards and waits (WP-14, WP-146).
- Model, effort and worker choice (WP-89, WP-120).
- Any new permission UI, mode or setting.

## Owned paths

- `src/features/sessions/model/session.ts`
- `src/integrations/harness/core/permissionMatrix.ts`
- `src/integrations/harness/providers/antigravity/antigravityProtocol.ts`
- `src/integrations/harness/providers/claude/claudeLaunch.ts`
- `src/integrations/harness/providers/claude/claudeProtocol.ts`
- `src/integrations/harness/core/permissionMatrix.ts` and its test
- `src/integrations/harness/providers/devin/devin.ts`, `devinProtocol.ts`, `fx/fx.ts`, `fxProtocol.ts`, `antigravity/antigravity.ts` (the refusal rule and mapping lookups; the adapters' own approval handlers are not touched)
- `README.md`, `docs/hivra/SOURCES.md`, `docs/hivra/credits.json` (Happy's line only)

## Decisions

- **Strictness is the CLI's own rank (review 2, HIGH).** A phone pick or a refused change is compared by `PERMISSION_MATRIX[cli][mode].rank`, not by Hivra's order. Antigravity's Auto runs as its default, which is stricter than auto-accept edits, so a pick of auto-accept edits never loosens an Auto chat. A tie keeps the chat's own mode. Hivra's order is used only for a harness with no table.
- **The phone can only tighten a chat (4.1).** `phoneModeChange` takes the chat's own mode (live, else saved; an unknown value counts as Supervised) and the phone's pick. The stricter one wins. When the pick is looser or tied, the configure call returns an error that names the mode the chat stays on, and the phone resets its pick. Checked before anything changes, so a refused pick leaves the chat as it was.
- **New chats from the phone take the stricter of the default and the pick (decided by Ash).** The default is the active session's mode, else Supervised: the code has no separate project or Mono default mode setting. The same rank rule applies.
- **Leaving fx resets the mode to Supervised.** fx's Full access is its only offer and must not carry to another CLI. Applies to the desktop model change and the phone configure.
- **fx approves its own requests in every stored mode (MED 3).** Supervised, auto-accept edits and Auto all read "fx approves its own requests", with a hint that nothing is asked before fx acts. Full access reads "Full access". The phone's model sheet and the desktop picker show the same names.
- **fx is offered with Full access only (4.2, for now, decided by Ash).** The picker on fx offers Full access alone. A chat that is not on Full access still shows its honest name, and Enter on it picks nothing.
- **Antigravity's Auto is named for what it runs (4.3).** It reads "Default (no AI review)", and its hint says its approvals are not reviewed by an AI. Its setting is unchanged. Claude, Devin and other harnesses keep the shared labels.
- **Refusals name the CLI's mode.** The refusal notice uses the CLI's own name for each mode.
- **Devin's reported mode (LOW 8).** A `current_mode_update` sets the row the CLI reports. A setting two rows share is not enough to tell which, so the mode is unknown and a refusal waits.
- **fx ignores only "method not found" on set_mode (LOW 9, intended).** Any other set_mode refusal on a fresh fx turn ends that turn as waiting. This fails safe.
- **The phone reads the desktop's modes for each harness (MED 2).** The catalog sends `runtimeModesByHarness` (every mode, with its CLI name and an `offered` flag). The phone's picker uses the chat's own harness and shows only offered modes. The phone's mobile/ code is not type-checked or tested here (no node_modules in this worktree).
- **Known gaps stay open.** fx Supervised does not ask before it acts (WP-14 and WP-146, decided by Ash to leave as is). Antigravity default has no AI review, now named as such.

## Done when

- [x] One matrix module exists, and every adapter's mapping reads from it.
- [x] A refused mode change follows one rule on Claude, Devin, Antigravity and `fx`, and tests pin it.
- [x] Plan handling is written down per CLI in the matrix.
- [x] The resolution order is one tested function, with no sandbox fallback. The phone path uses it (`resolvePhoneRuntimeMode`), so a phone pick can tighten a chat but never loosen it.
- [x] Supervised never sends bypass on any CLI (test).
- [x] fx's Supervised and Antigravity's Auto are named for what they do, and fx is offered with Full access only.
- [ ] `SOURCES.md`, `credits.json` and `NOTICE` list Happy (idea only, MIT). SOURCES and credits.json are done; NOTICE is not.
- [ ] `npm run check` passes. Scoped checks only so far. The live check is one real Claude session and one Antigravity session switching mode, run in a dev copy, and it has not been run.
