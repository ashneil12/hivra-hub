import { describe, expect, it } from "vitest";
import { BridgeModelError, bridgeFamily, bridgeLaunchModel, bridgeModelName, isClaudeAliasModel } from "./bridgeModels";

describe("bridgeLaunchModel", () => {
  it("places every Claude alias on the bridge's own model", () => {
    for (const model of ["sonnet", "opus", "haiku", "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5", "claude:haiku", "opus[1m]"]) {
      expect(bridgeLaunchModel(model, "grok")).toBe("grok-4.7");
      expect(bridgeLaunchModel(model, "deepseek")).toBe("deepseek-v4.1-flash");
    }
  });

  it("places Grok and DeepSeek names, and no name at all", () => {
    expect(bridgeLaunchModel(undefined, "grok")).toBe("grok-4.7");
    expect(bridgeLaunchModel("", "grok")).toBe("grok-4.7");
    expect(bridgeLaunchModel("claude:deepseek-v4.1-flash", "grok")).toBe("deepseek-v4.1-flash");
    expect(bridgeLaunchModel("grok-4.7", "deepseek")).toBe("deepseek-v4.1-flash");
    // The catalog's own key for an unlisted name ("claude-" + dots as dashes) keeps its family.
    expect(bridgeLaunchModel("claude-grok-4-7", "grok")).toBe("grok-4.7");
    expect(bridgeLaunchModel("claude-deepseek-v4-1-flash", "grok")).toBe("deepseek-v4.1-flash");
    expect(bridgeFamily("claude-deepseek-v4-1-flash")).toBe("deepseek");
  });

  it("fails closed on anything else", () => {
    for (const model of ["gpt-5.6-sol", "gemini-4-argon", "sonnetish", "claudeish", "qwen-3"]) {
      expect(() => bridgeLaunchModel(model, "grok")).toThrow(BridgeModelError);
      expect(bridgeFamily(model)).toBe("unknown");
      expect(bridgeModelName(model, "grok")).toBeUndefined();
    }
  });

  it("names what really runs", () => {
    expect(bridgeModelName("claude:sonnet-5", "grok")).toBe("Grok 4.7");
    expect(bridgeModelName("claude:deepseek-v4.1-flash", "grok")).toBe("DeepSeek V4.1 Flash");
    expect(bridgeModelName("claude:grok-4.7", "deepseek")).toBe("DeepSeek V4.1 Flash");
  });

  it("tells a habitual Claude name from an explicit choice", () => {
    expect(isClaudeAliasModel(undefined)).toBe(true);
    expect(isClaudeAliasModel("claude:sonnet-5")).toBe(true);
    expect(isClaudeAliasModel("claude:haiku")).toBe(true);
    expect(isClaudeAliasModel("claude:grok-4.7")).toBe(false);
    expect(isClaudeAliasModel("custom:deepseek-abc")).toBe(false);
  });
});
