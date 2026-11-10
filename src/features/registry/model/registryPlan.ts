// WP-134b. Decides whether a turn uses one of the eleven CLIs or a More agents chat.
// A registry id is never handed to asHarness or Kind::from_id.

import {
  AGENT_GONE,
  MORE_AGENTS_OFF,
  UNSUPPORTED_PROTOCOL,
  WAITS,
} from "./registryCopy";

export type RegistryAgentRef = {
  id: string;
  name: string;
  command: string;
  args: string[];
  protocol: string;
};

export type RegistrySendPlan =
  | { action: "cli" }
  | { action: "refuse"; sentence: string; retryable: boolean }
  | { action: "queue"; sentence: string }
  | { action: "prompt"; agent: RegistryAgentRef };

/**
 * `fallbacks` exist so a test can pass functions that throw. This function
 * must not call them: a registry id is not a CLI id.
 */
export function registrySendPlan(input: {
  registryAgentId?: string;
  enabled: boolean;
  agents: RegistryAgentRef[];
  busy: boolean;
  fallbacks?: {
    asHarness?: (id: string) => string;
    fromId?: (id: string) => string;
  };
}): RegistrySendPlan {
  const id = typeof input.registryAgentId === "string" ? input.registryAgentId.trim() : "";
  if (!id) return { action: "cli" };
  void input.fallbacks;
  if (!input.enabled) {
    return { action: "refuse", sentence: MORE_AGENTS_OFF, retryable: false };
  }
  const agent = input.agents.find((row) => row.id === id);
  if (!agent || !agent.command.trim()) {
    return { action: "refuse", sentence: AGENT_GONE, retryable: false };
  }
  if (agent.protocol !== "acp-v1") {
    return { action: "refuse", sentence: UNSUPPORTED_PROTOCOL, retryable: false };
  }
  if (input.busy) return { action: "queue", sentence: WAITS };
  return { action: "prompt", agent };
}
