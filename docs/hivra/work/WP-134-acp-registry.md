# WP-134: ACP registry and long-tail providers: design only

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | L | none | yes |

This package is design only: no product code except this doc and the SOURCES / inspirations notes.

## Goal

A design for how Hivra adds long-tail agents (Copilot CLI, and other ACP agents) without lowering the bar the eleven first-class CLIs already meet. First-class stays first-class. A registry agent is clearly "more agents", with a documented capability subset, and it does not become a twelfth CLI just by speaking ACP.

## Why

Copilot CLI had 130 +1 on T3 [issue #193](https://github.com/pingdotgg/t3code/issues/193) (closed, later supported). T3's ACP Registry was a V2 headline ([providers-acp.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/providers-acp.md), [v0.1.0](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0)). Hivra already has eleven CLIs, including Devin, Antigravity, Pi and fx, but no way to add an agent that is not one of those eleven. This is a platform decision, so design first.

## Read first

- Hivra: `src/features/sessions/model/session.ts` (`HarnessId`, `HARNESSES`), `src/integrations/harness/core/register.ts`, `crates/monocode-core/src/provider/kind.rs`, the shared ACP lifecycle in `crates/monocode-core/src/provider/acp.rs`.
- T3, ideas only, at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`: [providers-acp.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/providers-acp.md) and `docs/internals/adding-a-provider.md`. Do not copy T3 source.

## Design

### The eleven, and the cost of a twelfth

The eleven ids are `claude`, `codex`, `cursor`, `grok`, `opencode`, `pi`, `omp`, `fx`, `hermes`, `antigravity` and `devin`. The same eleven are `HarnessId` in `session.ts` and `Kind` in `kind.rs`. `Kind::ALL` is eleven long. The Rust test `registry_matches_the_react_harnesses` reads `register.ts` and fails unless every kind has a `src/integrations/harness/providers/<id>/` package. The install hint in `kind.rs` is checked against the same words in `availability.ts`. A new first-class CLI is not a string. It is a change that has to land on both sides or those tests fail.

They do not share one protocol.

| CLI | How a turn is sent | Mid-turn steer |
| --- | --- | --- |
| Claude Code | The Claude CLI's stream-json control protocol | Allowed |
| Codex | `codex app-server` | Allowed |
| Pi | `pi --mode rpc` (`piFamily`) | Allowed |
| omp | The same Pi RPC family, as its own flavor (`OMP_FLAVOR` in `host/providers.ts`) | Allowed |
| OpenCode | Its own HTTP service (`opencode::run` in Rust, `OpenCodeClient` in TypeScript). A turn never enters the shared ACP lifecycle | Allowed |
| Cursor, Grok Build, fx, Hermes Agent, Antigravity, Devin | The shared ACP lifecycle. The process is started with an `acp` argument (Grok uses `agent ... stdio` instead) | Cursor and Hermes allowed. Grok, fx, Antigravity and Devin set `canSteer: false` |

"Allowed" means the adapter does not set `canSteer: false`. `canSteerHarness` in `registry.ts` treats a missing flag as yes. It does not mean every mid-turn message succeeds.

OpenCode is the trap in the flag. `Kind::is_acp()` is true for every kind except Codex, Claude, Pi and omp, so it is true for OpenCode, and `acp.rs` still has an OpenCode plan/build arm. `run_operation` in `provider.rs` returns into `opencode::run` before that lifecycle starts. Speaking ACP, or being marked `is_acp()`, is not what makes a CLI first-class, and it is not a generic slot a new agent can fall into.

The shared ACP file is already full of per-CLI branches: launch arguments, request timeouts, `session/resume` versus `session/load`, permission defaults, and how cancel answers pending approvals (Antigravity and Devin). The client tells every ACP agent the same thing at initialize: protocol version 1, and that Hivra will not read or write files or run a terminal for the agent (`clientCapabilities` in `acp_start`, mirrored in the TypeScript adapters). The agent does its own file and shell work and asks Hivra with `session/request_permission`. An ask Hivra does not know (anything other than `session/request_permission` and the Cursor and Grok question methods) is answered with JSON-RPC error -32601 and is not shown in the chat. `Kind::from_id` turns an unknown id into Codex. A registry id must never be passed through that function.

What a twelfth first-class id has to touch, using Devin's addition as the shape:

- The id itself: `HarnessId`, `HARNESSES`, `HARNESS_LABEL` and `HARNESS_TITLE` in `session.ts`. `harnessSupportsAttachments` is a per-id exception (fx cannot take attachments).
- Registration: `registerBuiltinHarnesses` in `register.ts`, and a package under `src/integrations/harness/providers/<id>/`. Devin's package is the recent one: adapter, protocol, catalog, auth, text generation, subagents, and tests.
- Settings: the Agent CLIs group in `SettingsView.tsx` maps over `HARNESSES`, so the row appears with the id, but only after the catalog, the install hint (`availability.ts`) and the icon (`HarnessIcon.tsx`) exist. `DEFAULT_MODEL_ID` in `models.ts` is a full record.
- Auth and accounts: `auth.ts`, `authSupport.ts`, and the provider account screens where the CLI has a sign-in of its own.
- Crews and the first mate: `CLI_ORDER` in `src/features/crew/model/clis.ts` (same eleven, different order) and `FIRST_MATE_READ_ONLY` in `src/features/firstmate/model/readOnly.ts`, which may say only "checked after the turn" but must have a row.
- The host process: `host/providers.ts` imports every provider module by path.
- The phone app and the native shell: Devin's id also landed in `mobile/src/features/workspace/types.ts`, `mobile/src/features/sessions/providerSvgs.ts`, `crates/monocode-gpui` (theme and assets) and `crates/monocode-core` (kind, catalog, usage, skills, the remote protocol).
- Rust, if the CLI is ACP: a `Kind` arm, plus the branches in `acp.rs`. If it is not ACP: a new transport module and a branch in `run_operation`, the way OpenCode, Codex and Claude each have one.
- Sessions on disk only load a harness that is in `HARNESSES` (`sessionStore.ts`). An unknown harness string is not a session.

That list is the bar. A registry agent does not clear it, and this design does not lower it.

GitHub Copilot as a model inside Pi and omp is not one of the eleven and is not Copilot CLI. `providerNames.ts` labels `github-copilot` as "GitHub Copilot", and the Pi catalog hides Copilot's internal model ids. That stays as it is.

The plugin registry (WP-30) is also a different thing. It records skills and contributions for agents that already run. An ACP agent does not belong in `plugin.json`.

## Done when

- [ ] The design names the first-class bar and the registry subset.
- [ ] Copilot has a recommended path.
- [ ] No provider code was added.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
