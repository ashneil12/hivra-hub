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

- [ ] Ported policy and block-list tests (credit in headers), plus a proxy test that a refused call never reaches the
      sidecar.
- [ ] Full security review.
- [ ] Verified on the Mac in a dev copy (the native part cannot be proved in CI).
