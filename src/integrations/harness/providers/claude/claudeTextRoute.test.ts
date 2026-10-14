import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ studio: true }));
vi.mock("../../../../features/providers/model/providerBinaryPaths", () => ({
  isCcStudioClaudeRuntime: () => runtime.studio,
}));
import { pickTextModel } from "./claudeText";
import { setProjectDefaultModel } from "../../../../features/sessions/model/projectProviders";

beforeEach(() => {
  runtime.studio = true;
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Claude auxiliary upstream routing", () => {
  it("keeps concurrent originating session routes exact even in the same project", () => {
    expect(pickTextModel("claude:ccstudio:experiential:deepseek-v4.1-flash", "/same-project")).toBe("ccstudio:experiential:deepseek-v4.1-flash");
    expect(pickTextModel("claude:ccstudio:experiential:gemini-4-argon", "/same-project")).toBe("ccstudio:experiential:gemini-4-argon");
    expect(pickTextModel("claude:sonnet-4.6", "/same-project")).toBe("claude-sonnet-4-6");
    expect(pickTextModel("claude:ccstudio:grok:grok-4.7", "/same-project")).toBe("ccstudio:grok:grok-4.7");
  });

  it("skips unknown studio helper routes instead of guessing Haiku", () => {
    expect(() => pickTextModel(undefined, "/unconfigured")).toThrow("Auxiliary generation skipped");
  });

  it("uses the explicitly selected project model for project-wide git helpers", () => {
    setProjectDefaultModel("/configured", "claude", "claude:ccstudio:experiential:deepseek-v4.1-flash");
    expect(pickTextModel(undefined, "/configured")).toBe("ccstudio:experiential:deepseek-v4.1-flash");
  });

  it("retains native helper behavior in a stock Claude build", () => {
    runtime.studio = false;
    expect(pickTextModel(undefined, "/unconfigured-native")).toBe("claude-haiku-4-5");
  });
});
