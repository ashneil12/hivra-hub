// WP-134b. Decides whether a turn uses one of the eleven CLIs or a More agents chat.
// A registry id is never handed to asHarness or Kind::from_id.

import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import {
  AGENT_GONE,
  MORE_AGENTS_OFF,
  NOT_APPROVED,
  UNSUPPORTED_PROTOCOL,
  WAITS,
} from "./registryCopy";
import type { RegistryAgent } from "./registryList";

export type RegistryAgentRef = RegistryAgent;

export type RegistrySendPlan =
  | { action: "cli" }
  | { action: "refuse"; sentence: string; retryable: boolean }
  | { action: "queue"; sentence: string }
  | { action: "prompt"; agent: RegistryAgentRef };

/** A new More agents chat. `harness` stays one of the eleven. The agent id does not. */
export function registrySessionFields(
  agent: { id: string; name: string },
  placeholder: HarnessId,
): { harness: HarnessId; registryAgentId: string; title: string } {
  if (!(HARNESSES as string[]).includes(placeholder)) {
    throw new Error("The placeholder must be one of the eleven CLIs.");
  }
  if ((HARNESSES as string[]).includes(agent.id)) {
    throw new Error("A registry id cannot be a CLI id.");
  }
  return { harness: placeholder, registryAgentId: agent.id, title: agent.name };
}

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
  // The app checks the approval again when the chat starts; this only says why before it gets that far.
  if (!agent.approved) {
    return { action: "refuse", sentence: NOT_APPROVED, retryable: false };
  }
  if (input.busy) return { action: "queue", sentence: WAITS };
  return { action: "prompt", agent };
}
