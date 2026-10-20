import { describe, expect, it } from "vitest";
import { claudeLaunchDelta, joinLabels, type ClaudeLaunch } from "./claudeLaunch";
import { promptCacheTtlFromUsage } from "./claudePromptCache";

const base: ClaudeLaunch = {
  model: "claude-opus-4-6",
  effort: "high",
  permissionMode: "default",
  thinking: false,
  fast: false,
  ultracode: false,
  hooks: true,
  autoCompactWindow: 350_000,
};

describe("claudeLaunchDelta", () => {
  it("is empty when nothing changed", () => {
    expect(claudeLaunchDelta(base, { ...base })).toEqual({ restart: [], requests: [] });
  });

  it("applies model, effort, fast mode, ceiling and permissions live", () => {
    const delta = claudeLaunchDelta(base, {
      ...base,
      model: "claude-opus-4-6[1m]",
      effort: "max",
      fast: true,
      autoCompactWindow: undefined,
      permissionMode: "bypassPermissions",
    });
    expect(delta.restart).toEqual([]);
    expect(delta.requests.map((r) => r.request)).toEqual([
      { subtype: "set_model", model: "claude-opus-4-6[1m]" },
      { subtype: "apply_flag_settings", settings: { effortLevel: "max", fastMode: true, autoCompactWindow: null } },
      { subtype: "set_permission_mode", mode: "bypassPermissions" },
    ]);
  });

  it("needs a new process for thinking, hooks, a custom route and going back to default effort", () => {
    expect(claudeLaunchDelta(base, { ...base, thinking: true }).restart).toEqual(["thinking"]);
    expect(claudeLaunchDelta(base, { ...base, hooks: false }).restart).toEqual(["hooks"]);
    expect(claudeLaunchDelta(base, { ...base, route: "openrouter" }).restart).toEqual(["model"]);
    expect(claudeLaunchDelta({ ...base, route: "r" }, { ...base, route: "r", model: "other" }).restart).toEqual(["model"]);
    expect(claudeLaunchDelta(base, { ...base, effort: undefined }).restart).toEqual(["effort"]);
  });

  it("names what changed for the chat", () => {
    expect(joinLabels(["model"])).toBe("model");
    expect(joinLabels(["model", "effort, fast mode", "permission mode"])).toBe(
      "model, effort, fast mode and permission mode",
    );
  });
});

describe("promptCacheTtlFromUsage", () => {
  it("reads the cache lifetime a turn wrote, as CLI 2.1.302 reports it", () => {
    expect(promptCacheTtlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 2048, ephemeral_5m_input_tokens: 0 } })).toBe(3_600_000);
    expect(promptCacheTtlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 9 } })).toBe(300_000);
    expect(promptCacheTtlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } })).toBeUndefined();
    expect(promptCacheTtlFromUsage(undefined)).toBeUndefined();
  });
});
