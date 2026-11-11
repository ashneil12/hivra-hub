import { invoke } from "@tauri-apps/api/core";

/**
 * Settings > General: "Run agents in the macOS sandbox" (src-tauri/src/agent_sandbox.rs). Off until the person turns it on.
 * The switch is the same file the app reads (`<app data>/settings/agent-sandbox`); the environment variable wins over it.
 */
export const AGENT_SANDBOX_DEFAULT = false;

export type AgentSandboxStatus = {
  /** macOS only. Elsewhere the row is not offered. */
  supported: boolean;
  enabled: boolean;
  /** MONOCODE_AGENT_SANDBOX is set, so the environment decides and the switch cannot change it. */
  setByEnvironment: boolean;
};

export const AGENT_SANDBOX_LABEL = "Run agents in the macOS sandbox";

export const AGENT_SANDBOX_DESCRIPTION =
  "Off by default. When on, each agent Hivra starts, and each project action or Setup it runs, works inside a macOS " +
  "sandbox. An agent's Ship, Run dev slot and stack actions are wrapped or refused. Ash's own tap still starts Ship " +
  "and Run dev slot without the wrap. The sandbox blocks reads and writes of SSH keys, cloud logins, password stores " +
  "and shell profiles. It blocks writes to your global git config, including nested includes, LaunchAgents, the " +
  "settings and hooks of Claude Code and Codex, the named checkout's .git (hooks, config and attributes, including a " +
  "linked worktree's common directory), the tool folders the app runs programs from, the cron and at tables, the " +
  "installed MonoCode Hub.app, and Hivra's data folder. It blocks creating login items, opening other apps, and " +
  "running crontab, at and hdiutil. It blocks the Docker socket. It does not block a copy of a tool under another " +
  "name. It does not cover other files, the network or other programs, so it is a list of known places, not a full " +
  "cage. Other projects' repos are not listed. Keychain items the security tool can read are not covered. Codex " +
  "chats that use Codex's own sandbox are not wrapped, because macOS refuses a sandbox inside a sandbox, and those " +
  "chats can read secrets and widen their own sandbox. While this sandbox is on, those chats ask before a permission " +
  "or a file change outside the workspace. A full access Codex chat is wrapped. Expect these to fail under it: git " +
  "push -u and other commands that write the named checkout's .git/config, git worktree add inside that checkout, " +
  "git over SSH, gh, docker, and npm with a private registry. Changes apply to agents and actions started after the " +
  "change. A start the sandbox refuses is written to the activity log.";

export const AGENT_SANDBOX_ENVIRONMENT_NOTE =
  "MONOCODE_AGENT_SANDBOX is set, so the environment decides and this switch cannot change it. Unset it to use the switch.";

export const loadAgentSandbox = () => invoke<AgentSandboxStatus>("agent_sandbox_status");

export const saveAgentSandbox = (enabled: boolean) =>
  invoke<AgentSandboxStatus>("agent_sandbox_set", { enabled });
