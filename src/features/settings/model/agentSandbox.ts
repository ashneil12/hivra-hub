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
  "sandbox. The sandbox blocks reads and writes of SSH keys, cloud logins, keychains, password stores and shell " +
  "profiles. It blocks writes to your global git config, LaunchAgents, the settings and hooks of Claude Code and " +
  "Codex, the .git folder, its hooks and its config, and Hivra's own switch and database. It blocks the security, " +
  "launchctl, open and osascript tools. It does not cover other files, the network or other programs, so it is a " +
  "list of known places, not a full cage. Expect these to fail under it: git push -u and other commands that write " +
  ".git/config, git over SSH, gh, docker, npm with a private registry, and a CLI sign-in that reads the Keychain " +
  "through the security tool or needs a browser (copy the link by hand); the sign-in path is not measured yet. " +
  "Changes apply to agents and actions started after the change. A start the sandbox refuses is written to the " +
  "activity log.";

export const AGENT_SANDBOX_ENVIRONMENT_NOTE =
  "MONOCODE_AGENT_SANDBOX is set, so the environment decides and this switch cannot change it. Unset it to use the switch.";

export const loadAgentSandbox = () => invoke<AgentSandboxStatus>("agent_sandbox_status");

export const saveAgentSandbox = (enabled: boolean) =>
  invoke<AgentSandboxStatus>("agent_sandbox_set", { enabled });
