// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { defaultModelId, defaultSessionChoice, loadLastModelChoice, saveLastModelChoice } from "../../sessions/model/models";
import { seedHubBundleDefaults } from "./hubBundle";

beforeEach(() => localStorage.clear());

describe("the Hub bundle's first run", () => {
  it("starts new chats on Claude Code", () => {
    expect(defaultSessionChoice().harness).toBe("cursor"); // MonoCode's own fallback, untouched
    seedHubBundleDefaults(true);
    expect(loadLastModelChoice()).toEqual({ harness: "claude", model: defaultModelId("claude") });
    expect(defaultSessionChoice().harness).toBe("claude");
  });

  it("only once, and never over a choice Ash already made", () => {
    saveLastModelChoice("codex", defaultModelId("codex"));
    seedHubBundleDefaults(true);
    expect(loadLastModelChoice()?.harness).toBe("codex");
    localStorage.clear();
    seedHubBundleDefaults(true);
    saveLastModelChoice("grok", defaultModelId("grok"));
    seedHubBundleDefaults(true);
    expect(loadLastModelChoice()?.harness).toBe("grok");
  });

  it("does nothing in MonoCode itself", () => {
    seedHubBundleDefaults(false);
    expect(loadLastModelChoice()).toBeNull();
    expect(defaultSessionChoice().harness).toBe("cursor");
  });
});
