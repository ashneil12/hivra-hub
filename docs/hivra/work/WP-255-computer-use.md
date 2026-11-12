# WP-255: Computer use, off by default, with a block list for password apps

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| P | L | none | no |

## Goal

A first mate can look at and use desktop apps on the Mac when Ash turns it on, with the same safety Up.computer has:
off by default, per chat allow / observe only / deny, an optional allowed-apps list, and a fixed block list of
password, wallet and system sign-in apps that no setting can lift.

## Why

Up.computer (MIT) ships desktop control through the MIT `open-computer-use` sidecar (iFurySt/open-computer-use) as an
MCP server, with `ComputerUsePolicy.ts` and `SensitiveApps.ts` deciding what a tool call may touch. Hivra has a browser
agent but no desktop control.

## Read first

- Up.computer `packages/computer-use-server/src/computerUse/`: `ComputerUsePolicy.ts`, `SensitiveApps.ts`,
  `ManagedComputerUseSidecar.ts`, `McpComputerUseClient.ts`, and their tests. Copy the policy and the block list with
  credit; the sidecar is installed, not vendored.
- Hivra: `src-tauri/src/mcp.rs` (how a chat's MCP servers are written), `src-tauri/src/agent_sandbox.rs`,
  `src/features/browser/`.

## Build

1. Settings > Computer use: off by default. On asks macOS for Accessibility and Screen Recording for the sidecar.
2. The sidecar is added to a chat's MCP servers only when the setting is on and the chat's mode is allow or observe
   only. Hivra proxies its tools so every call passes the policy first.
3. Policy, ported: deny refuses all; observe only refuses every action that clicks, types or drags; the allowed-apps
   list (when set) refuses any tool without a target app, so it rules out whole-screen captures; the sensitive-app
   list always refuses.
4. Every allowed call goes in the activity log with the app name.

## Done when

- [x] Ported policy and block-list tests (credit in headers), plus a proxy test that a refused call never reaches the
      sidecar.
- [ ] Full security review.
- [ ] Verified on the Mac in a dev copy (the native part cannot be proved in CI).

## Built (12 Nov)

- Rust `src-tauri/src/computer_use/`: `tools.rs` (the ten tools and the only arguments each sends), `sensitive.rs`
  (the block list), `policy.rs` (Up.computer's order, plus each chat's own say), `store.rs` (settings file, activity
  log, finding the sidecar), `proxy.rs` (`monocode computer-use`), and Settings' commands in `mod.rs`.
- A chat's session gets the `computer` entry (hubMcp.ts) only while it is on, on a Mac, for a chat Ash talks to (a
  Mono's own chat, a coding-team chat, a plain chat; never a worker, a habit run or the checker), and not set to off.
- Settings > General > Computer use: off by default, Look only (default) or Look and use, allowed apps, clicking by
  position (off), Check setup (`open-computer-use doctor`), chats with their own say, recent activity. The palette has
  "Computer use: look only / off / follow Settings in this chat".

## Security review

What it guards: the model's computer-use tools stay inside Ash's settings and away from password and payment apps.
What it does not guard: a chat's shell, which could start any program; that is Claude Code's permission prompt and
the macOS sandbox switch's job. Checked:

1. A refused call never reaches the sidecar (proxy test). The settings file is read again before every call, so off,
   look only, and a chat set to off hold mid-turn. A missing or broken file is off.
2. Only mapped arguments reach the sidecar: a window id, `window_placement` (which can hide a window from Ash), the
   sidecar's `auto` or `global` click method (which can press a nearby button or move the real pointer), `key_method`
   and `include_*` are all dropped. The sidecar's own `OPEN_COMPUTER_USE_*` and `OCU_*` switches are stripped from its
   environment, so `ALLOW_GLOBAL_POINTER_FALLBACKS` can't send input to whatever app is in front.
3. Key presses and typing go to the named app's process (`postToPid` in the sidecar), not the front app.
4. The sidecar resolves an app by exact name, executable name or bundle id, never a fuzzy match, so the block list
   sees the name it acts on. The sidecar keeps its own bundle-id block list too.
5. The activity log never holds typed text or set values, only their length; key names and app names are capped.
6. Only text and image content comes back to the chat; any other content type or `_meta` is dropped.
7. Hub chats are denied editing the settings file and the log, and running `open-computer-use`, `ocu` or
   `monocode computer-use` by hand (credentialGuard.ts). The entry is never pre-approved.
8. The server's instructions say what an app shows is data, never instructions.

Open, for the Mac check: the sidecar's "Locked Use" (it can unlock a locked Mac) is a separate install and not one of
the ten tools, so Hivra never asks for it; confirm on the Mac that `doctor` doesn't install it. An allowed app (a
browser) can still show a password manager's autofill; the block list is by app, not by what a window shows.
