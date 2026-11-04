import { describe, expect, it } from "vitest";
import {
  BridgeModelError,
  bridgeFamily,
  bridgeLaunchModel,
  bridgeModelName,
  isClaudeAliasModel,
} from "./deepseekBridge";

describe("bridgeLaunchModel", () => {
  it("places every Claude alias on DeepSeek", () => {
    for (const model of [
      "sonnet",
      "opus",
      "haiku",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-haiku-4-5",
      "claude:haiku",
      "opus[1m]",
    ]) {
      expect(bridgeLaunchModel(model, "deepseek")).toBe("deepseek-v4.1-flash");
    }
  });

  it("places a DeepSeek name, a Grok-family name, and no name at all", () => {
    expect(bridgeLaunchModel(undefined, "deepseek")).toBe("deepseek-v4.1-flash");
    expect(bridgeLaunchModel("", "deepseek")).toBe("deepseek-v4.1-flash");
    expect(bridgeLaunchModel("claude:deepseek-v4.1-flash", "deepseek")).toBe(
      "deepseek-v4.1-flash",
    );
    expect(bridgeLaunchModel("grok-4", "deepseek")).toBe("deepseek-v4.1-flash");
    expect(bridgeFamily("claude-deepseek-v4-1-flash")).toBe("deepseek");
    expect(bridgeFamily("grok-4")).toBe("grok");
  });

  it("fails closed on anything else", () => {
    for (const model of ["gpt-5.6-sol", "gemini-4-argon", "sonnetish", "claudeish", "qwen-3"]) {
      expect(() => bridgeLaunchModel(model, "deepseek")).toThrow(BridgeModelError);
      expect(bridgeFamily(model)).toBe("unknown");
      expect(bridgeModelName(model, "deepseek")).toBeUndefined();
    }
  });

  it("names what really runs", () => {
    expect(bridgeModelName("claude:sonnet-5", "deepseek")).toBe("DeepSeek V4.1 Flash");
    expect(bridgeModelName("claude:deepseek-v4.1-flash", "deepseek")).toBe(
      "DeepSeek V4.1 Flash",
    );
  });

  it("tells a habitual Claude name from an explicit choice", () => {
    expect(isClaudeAliasModel(undefined)).toBe(true);
    expect(isClaudeAliasModel("claude:sonnet-5")).toBe(true);
    expect(isClaudeAliasModel("claude:haiku")).toBe(true);
    expect(isClaudeAliasModel("claude:deepseek-v4.1-flash")).toBe(false);
    expect(isClaudeAliasModel("custom:deepseek-abc")).toBe(false);
  });
});
