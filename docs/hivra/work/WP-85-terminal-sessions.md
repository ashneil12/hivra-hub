# WP-85: Claude Code sessions started in a terminal show up in Hivra

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| G | L | 50, 70 | yes |

## Goal

When the person runs `claude` in a plain terminal, that session appears in Hivra while it runs, beside the chats
Hivra started. The person can read it, reply, stop a turn and answer a permission prompt from Hivra, and attach it to
a task. It works on the Mac without the network, and it's off until the person turns it on.

## Why

Ash, 4 Nov: shared [HumanLayer](https://github.com/humanlayer/humanlayer) (Apache-2.0). Its Claude Code plugin
(`apps/riptide-claude-code-plugin`) mirrors sessions the person starts themselves into the app, live, with reply,
stop and permission answers. Hivra today sees only sessions it started, and WP-50 imports finished ones afterwards.
HumanLayer's plugin sends to its cloud; Hivra keeps the plugin's careful local half and swaps the cloud for Hivra's
own control port on the same Mac.

**What it replaces:** nothing runs twice. A session Hivra started is never mirrored (the plugin stays off when
Hivra's session variable is set, as HumanLayer's does with its own). WP-50 still imports history; a mirrored
session is not imported again.

## Read first

- HumanLayer: `apps/riptide-claude-code-plugin/README.md`, `hooks/hooks.json`, `hooks/mod.ts` (the Claude Code mod:
  it needs Claude Code 2.1.287 or later, finds its server by the parent pid, and does nothing in a session the daemon
  runs), `src/` (`server.ts`, `protocol.ts`, `mirror.ts`, `mapper.ts`, `transcript.ts`, `host.ts`, `status.ts`,
  `config.ts`, `cli.ts`) and `test/`. Also `apps/riptide-opencode-plugin` and `apps/riptide-pi-extension` for the
  same shape on other CLIs, and `packages/session-sdk-*` for the event types.
- Hivra: WP-50 (`src-tauri/src/history_import.rs` readers), the delegate MCP tool (`monocode mcp`, which reaches only
  its own copy's control port), `src-tauri/src/instance.rs` (`running.json`), WP-70 (tasks), WP-31 (plugin install).

## Build

1. **Copy the plugin** with HumanLayer's Apache-2.0 `LICENSE`, a `NOTICE` entry and credits.json, as
   `plugins/hivra-mirror/`. Keep `mod.ts`, the protocol and the mapper. Replace the cloud transport (login, PAT,
   `session-sdk-auth`) with Hivra's control port: the plugin finds the running Hivra through `running.json` in the
   daily data folder and connects only to that port. No login, no tokens, nothing leaves the Mac.
2. **Turning it on** is a setting ("Show my terminal Claude sessions"), off by default. Turning it on installs the
   plugin into the person's Claude Code with `claude plugin install` after showing exactly what it adds; turning it
   off uninstalls it. Hivra never edits `~/.claude/settings.json` by hand.
3. **Live view.** A mirrored session shows in the chat list with a "terminal" mark, its folder and its state. Text,
   tool calls and diffs stream in through the mapper.
4. **Steering**, as far as Claude Code's mod interface allows: reply (queued for the next turn), stop the running
   turn, and answer a permission prompt. Anything the interface doesn't allow is shown as read-only, and the PR says
   which.
5. **Tasks.** The person can attach a mirrored session to a task (WP-70), and it shows on the task's activity.
6. **When Hivra isn't running**, the plugin does nothing and Claude Code behaves exactly as without it. When Hivra
   starts during a session, the session appears from then on, with its earlier turns read from the transcript.
7. **Grok and others later.** The Claude Code plugin covers `claude-grok` too (it runs Claude Code). Port the OpenCode
   and Pi versions only if Ash starts using those CLIs.
8. **Dev copies** never install the plugin into the person's Claude Code. They use the dev Claude config folder
   (`~/.monocode-hub-dev/claude-config`) and a dev copy's own `running.json`, and tests use the fake Claude.

## Done when

- [ ] Tests:
  - off by default, and turning it on runs the install command once;
  - a session with Hivra's session variable set is not mirrored;
  - with Hivra not running, the plugin is silent and the session works;
  - mirrored events map to Hivra's chat blocks (ported from HumanLayer's tests);
  - reply, stop and a permission answer reach the session through the fake;
  - a dev copy never touches the person's Claude config.
- [ ] Browser spec: a terminal session appears live in the chat list and can be attached to a task.
- [ ] `npm run check` passes. Mac check (for Ash's list): a real `claude` in Terminal shows up in a dev copy.
