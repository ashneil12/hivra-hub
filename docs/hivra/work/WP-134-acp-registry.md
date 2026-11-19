# WP-134: ACP registry and long-tail providers (More agents)

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
- A session read from disk runs its harness through `asHarness` in `sessionStore.ts`. An unknown string becomes `cursor`, not a refusal. The Rust `Kind::from_id` becomes Codex instead. A registry id left in that field would open as Cursor on the desktop and as Codex in the native shell.

That list is the bar. A registry agent does not clear it, and this design does not lower it.

GitHub Copilot as a model inside Pi and omp is not one of the eleven and is not Copilot CLI. `providerNames.ts` labels `github-copilot` as "GitHub Copilot", and the Pi catalog hides Copilot's internal model ids. That stays as it is.

The plugin registry (WP-30) is also a different thing. It records skills and contributions for agents that already run. An ACP agent does not belong in `plugin.json`.

### A registry agent

A registry agent is a local command that speaks ACP version 1, listed under the eleven, and launched on the generic ACP path. It does not get a `HarnessId`, a `Kind`, a `providers/<id>/` package, a crew name, a first-mate row, or an arm in `acp.rs`. The eleven never appear in its list. T3 writes the same rule: an agent Hivra already supports as its own provider stays in Agent CLIs, and an agent-id check does not go in the generic adapter. A quirk the spec does not cover is a flavor module for that one agent. If the flavor grows into launch arguments, timeouts and permission policy, it is a first-class CLI and it pays the bar above.

A chat is one or the other. `harness` stays one of the eleven. A registry chat stores its agent id in its own field, and neither `asHarness` nor `Kind::from_id` is allowed to see it. Those two already disagree: the desktop turns an unknown harness into Cursor, and the native shell turns an unknown kind into Codex. Loading a chat whose agent is gone keeps the transcript and shows "This agent is no longer in your list." It does not launch.

The screen label is "More agents", on the providers settings page, below Agent CLIs. Not under Plugins.

### Where the manifest lives

The list sits with the other provider settings the desktop already keeps. Not a new database table, not `plugin.json`, and not a file the person has to hand-edit as the only way in. A person may also point at a manifest file. Either way the result is the same list.

Each entry is untrusted, the same as any settings read from disk. On read, check the fields below. A bad entry is shown as unusable and skipped. The rest of the list still loads. Unknown fields are ignored. A write carries the revision that window last read, the same rule as the local project documents, so one window cannot wipe an agent another window just added. Removing an entry drops the link only. It does not delete the agent's own files, its sign-in, or the chats.

The first slice does not download anything. The person names an executable that is already installed. Arguments are a list of literal strings, not a shell line, and Hivra does not expand them. Importing from the public ACP registry, checking a SHA-256, and choosing a folder for a downloaded binary are a later decision. Hivra does not run an installer it cannot checksum, and it does not copy T3's install layout.

Fields:

- `id`: a stable slug, not empty, not one of the eleven.
- `name`: the words the person sees.
- `command`: an executable name or a path.
- `args`: a list of strings.
- `protocol`: `acp-v1` only. Hivra's client sends protocol version 1. Anything else is "unsupported" and is not launched.
- Claimed abilities (cancel, permissions, previews, models, resume, steer). These are hints. The live `initialize` is what Hivra believes.

Extra environment variables are the names on that entry and the values the person typed there. They are not logged, and one entry's variables are not passed to another agent.

### What it has to be able to do

Usable means: the command starts, `initialize` succeeds at protocol version 1, and a turn can be sent with `session/new` (or `session/load` when continuing) and `session/prompt`. That is the generic path already used when a kind falls through to `command.arg("acp")`: an empty mode string, and the standard permission card. The registry path uses that and adds no kind arm.

Queue, approvals, diffs and cancel are the subset. Missing one does not hide the agent. The screen says what is missing.

- **Queue.** The chat uses the queue Hivra already has (`messageQueue.ts`). The person's own messages stay ahead of app deliveries. A registry agent does not get mid-turn steer. `canSteer` stays false, as it already does for Grok, fx, Antigravity and Devin. A follow-up waits until the turn finishes. Steer is a first-class extra, earned per CLI, not part of the subset.
- **Approvals.** A `session/request_permission` ask is the card the shared path already builds. The registry default is to show the ask. Do not copy the per-CLI shortcuts (fx allows for the rest of the session, Devin is one-time, Antigravity auto-accepts only edits). Do not pretend a mode the agent does not enforce. If the agent never asks, say so. Hivra still does not read, write or run a terminal for it. Those client capabilities stay false.
- **Diffs.** A tool update that carries `locations` or `preview` is shown, as today. A tool with neither still shows its title, plus "No preview from this agent." The project changes panel reads git, not the agent, so a file the agent wrote still appears there once git can see it.
- **Cancel.** Hivra sends `session/cancel` and marks the turn stopped locally. ACP does not promise a reply, and `acp_cancel` already treats it that way. The screen says "Stop sent." If the process is still running, the person can end the process. The screen does not say the agent confirmed it.

A command that is missing stays in the list. A command that does not answer, or a timeout, is "Not answering", with Retry. It is not a deleted entry and not a final failure.

| What is missing | What the person sees |
| --- | --- |
| The command was not found | "This agent was not found. Check the command in More agents." |
| `initialize` fails, or the protocol is not version 1 | "This agent does not speak the version Hivra supports." It is not launched as another CLI. |
| The agent never asks permission | "This agent does not ask before it acts." |
| The agent asks with a method Hivra does not know | "This agent asked for something Hivra cannot answer. The ask was declined." Today that ask is only a JSON-RPC -32601, with no line in the chat. The registry path shows the line. |
| A tool has no preview | "No preview from this agent." The changes panel still lists what git sees. |
| A message is sent while a turn runs | "Your message waits until this turn finishes." |
| Cancel is not confirmed | "Stop sent. This agent does not confirm it stopped." |
| Continuing the old session fails | "This chat cannot continue in the agent's last session. Start a new one." The transcript stays. |
| The entry was removed or no longer validates | "This agent is no longer in your list." The transcript stays. Nothing launches. |
| The agent names no models | "This agent did not name any models." The person can still send, on the agent's own default. |

Also outside the subset, until a later package proves one agent: a crew slot, a first-mate read-only row, a default model record, a subscription meter, an account waterfall, title or commit or pull request text, rewind, compaction, and attachments. Child agents stay ordinary tool rows. A crew tree for them is a flavor, not the generic path. Cursor's model-picker flag and Grok's extra session flags are not sent.

### What a later package would build

Not this one. The smallest build is More agents, add a local command, and one generic ACP session on the desktop TypeScript path, which is the path `App.tsx` already uses to send a turn. Tests have to show that an unknown id does not become Cursor or Codex, and that a bad entry does not wipe the list.

`Kind` stays the eleven. The native shell shows a registry agent as unavailable until it reads the same list. It does not call `from_id`.

### Copilot CLI

Copilot CLI is the request to take most care over. T3 issue 193 drew 130 +1 and was closed once T3 supported it. In the tree this design read, Copilot is not its own provider package. It is a flavor on the registry adapter (`packages/provider-acp-registry/src/server/copilotAcp.ts`). The flavor does three things the generic ACP path does not:

- It asks, in client metadata, for subagent and assistant-delta events.
- It routes those events onto a child session, so a subagent's text is not mixed into the parent.
- It treats two `session/prompt` errors as a lost session and replaces the process: "session event delivery failed: session not found" and "session lock unavailable during is_session_generation_current". Older Copilot puts the cause in `data.details`. A later native layer puts it in the message. The flavor accepts either.

Queue, approvals, diffs and cancel still come from the shared adapter. The flavor is why a purely generic entry is not enough, and why a twelfth CLI is too much.

Recommendation: registry, and the first named flavor. Not first-class.

Not first-class, because the bar above is a kind in both runtimes, a provider package, settings, a crew name, a first-mate row, the host, the phone app and the native shell. Copilot's extra behaviour needs none of that. Being the most asked-for agent is not a reason to pretend it is Claude.

Not generic with the flavor forgotten. A lost session that fails every later prompt must say "This chat's session is gone. Start it again." and replace the process. It must not look like an empty success, and it must not keep retrying the dead process. Subagent events Hivra cannot route stay on the parent as normal text. The chat does not draw a crew tree it cannot trust. That flavor is a later package, named here so it is not dropped, and it stays out of the generic adapter as its own module.

Not the GitHub Copilot models inside Pi and omp. Those stay. Copilot CLI is a different program. The person installs it and names the command under More agents. Hivra does not download it.

This can be overridden. If Copilot should sit in the Agent CLIs row beside Claude before any of the registry work exists, that is a first-class package and it pays the full bar, including a written reason the generic path cannot hold the lost-session errors. This design says do not do that.

### Sources this design does not take a row for

Orca's same-prompt fan-out is a different package. Paseo's relay is a different package. Cursor, Claude and Codex are already three of the eleven, and the rule that they stay out of the registry list is the T3 idea already credited. No separate source row.

### Not in this package

No provider package, no change to `HarnessId` or `Kind`, no settings key, and no manifest parser. The only edits are this doc, the T3 row in `docs/hivra/SOURCES.md`, and the matching inspiration line.

## Done when

- [x] The design names the first-class bar and the registry subset.
- [x] Copilot has a recommended path.
- [x] No provider code was added.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.

## Built in WP-134b

The first slice is built in `WP-134b-more-agents.md`: More agents (off by default), a local command the person already has installed, and one generic ACP session on the desktop TypeScript path. Copilot's flavor, downloads, and a twelfth CLI stay out.
