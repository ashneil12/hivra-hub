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
  "Off by default. When on, each agent Hivra starts runs inside a macOS sandbox. The sandbox blocks reads and writes " +
  "of SSH keys, cloud logins, keychains, password stores and shell profiles, and blocks writes to git hooks and git " +
  "config in any checkout. Everything else is still allowed, so this covers the known places, not every file. It " +
  "applies to agents started after the change. A start the sandbox refuses is written to the activity log.";

export const AGENT_SANDBOX_ENVIRONMENT_NOTE =
  "MONOCODE_AGENT_SANDBOX is set, so the environment decides and this switch cannot change it. Unset it to use the switch.";

export const loadAgentSandbox = () => invoke<AgentSandboxStatus>("agent_sandbox_status");

export const saveAgentSandbox = (enabled: boolean) =>
  invoke<AgentSandboxStatus>("agent_sandbox_set", { enabled });
