import { describe, expect, it, vi } from "vitest";
import { loadMoreAgentsEnabled } from "../../settings/model/settings";
import { AGENT_GONE, MORE_AGENTS_OFF, NOT_APPROVED, WAITS } from "./registryCopy";
import { registrySendPlan, registrySessionFields, type RegistryAgentRef } from "./registryPlan";

const agent: RegistryAgentRef = {
  id: "my-copilot",
  name: "My Copilot",
  command: "copilot",
  args: ["acp"],
  protocol: "acp-v1",
  approved: true,
};

function throwingFallbacks() {
  return {
    asHarness: vi.fn((id: string) => {
      throw new Error(`asHarness ${id}`);
    }),
    fromId: vi.fn((id: string) => {
      throw new Error(`fromId ${id}`);
    }),
  };
}

describe("registrySessionFields", () => {
  it("keeps the chat on one of the eleven and puts the agent id beside it", () => {
    const fields = registrySessionFields({ id: "my-copilot", name: "My Copilot" }, "claude");
    expect(fields).toEqual({
      harness: "claude",
      registryAgentId: "my-copilot",
      title: "My Copilot",
    });
    expect(() => registrySessionFields({ id: "claude", name: "Claude" }, "claude")).toThrow();
  });
});

describe("registrySendPlan", () => {
  it("sends a normal chat down the CLI path when More agents is off", () => {
    expect(loadMoreAgentsEnabled()).toBe(false);
    const fallbacks = throwingFallbacks();
    expect(
      registrySendPlan({
        enabled: loadMoreAgentsEnabled(),
        agents: [agent],
        busy: false,
        fallbacks,
      }),
    ).toEqual({ action: "cli" });
    expect(fallbacks.asHarness).not.toHaveBeenCalled();
    expect(fallbacks.fromId).not.toHaveBeenCalled();
  });

  it("still uses the CLI path when the setting is on but the chat has no registry id", () => {
    expect(
      registrySendPlan({
        enabled: true,
        agents: [agent],
        busy: true,
        registryAgentId: "  ",
      }),
    ).toEqual({ action: "cli" });
  });

  it("does not turn a registry id into Cursor or Codex when the setting is off", () => {
    const fallbacks = throwingFallbacks();
    const plan = registrySendPlan({
      enabled: false,
      agents: [agent],
      busy: false,
      registryAgentId: "my-copilot",
      fallbacks,
    });
    expect(plan).toEqual({
      action: "refuse",
      sentence: MORE_AGENTS_OFF,
      retryable: false,
    });
    expect(JSON.stringify(plan)).not.toMatch(/cursor|codex/i);
    expect(fallbacks.asHarness).not.toHaveBeenCalled();
    expect(fallbacks.fromId).not.toHaveBeenCalled();
  });

  it("refuses a missing agent and queues a busy one without calling the CLI fallbacks", () => {
    const fallbacks = throwingFallbacks();
    expect(
      registrySendPlan({
        enabled: true,
        agents: [],
        busy: false,
        registryAgentId: "gone",
        fallbacks,
      }),
    ).toEqual({ action: "refuse", sentence: AGENT_GONE, retryable: false });
    expect(
      registrySendPlan({
        enabled: true,
        agents: [agent],
        busy: true,
        registryAgentId: agent.id,
        fallbacks,
      }),
    ).toEqual({ action: "queue", sentence: WAITS });
    expect(fallbacks.asHarness).not.toHaveBeenCalled();
    expect(fallbacks.fromId).not.toHaveBeenCalled();
  });
});

describe("registrySendPlan approval", () => {
  it("refuses an entry the person has not allowed to run, and starts nothing", () => {
    const fallbacks = throwingFallbacks();
    expect(
      registrySendPlan({
        enabled: true,
        agents: [{ ...agent, approved: false }],
        busy: false,
        registryAgentId: agent.id,
        fallbacks,
      }),
    ).toEqual({ action: "refuse", sentence: NOT_APPROVED, retryable: false });
    expect(fallbacks.asHarness).not.toHaveBeenCalled();
  });
});
