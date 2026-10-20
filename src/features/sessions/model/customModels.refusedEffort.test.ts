// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  customModelRoute,
  effortDroppedNotice,
  effortDroppedText,
  listCustomModels,
  markEffortRefused,
  setCustomModelEfforts,
} from "./customModels";
import { resolveModel } from "./models";

const GROK = { id: "xai-g", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.6" };
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:custom-models", JSON.stringify([GROK, { ...GROK, id: "ds-1", provider: "deepseek", name: "DeepSeek" }]));
});

describe("levels a provider refused", () => {
  it("are kept per model and per level, survive a reload, and are never sent again", () => {
    expect(markEffortRefused({ customModelId: "xai-g", effort: "medium" })).toBe(true);
    expect(markEffortRefused({ customModelId: "xai-g", effort: "medium" })).toBe(false);
    expect(markEffortRefused({ customModelId: "nope", effort: "medium" })).toBe(false);
    expect(markEffortRefused({ customModelId: "xai-g", effort: "ultra" })).toBe(false);
    expect(JSON.parse(localStorage.getItem("monocode:custom-models")!)[0].refusedEfforts).toEqual(["medium"]);
    expect(customModelRoute({ model: "custom:xai-g", modelSettings: { effort: "medium" } })).not.toHaveProperty("reasoningEffort");
    expect(customModelRoute({ model: "custom:xai-g", modelSettings: { effort: "high" } })).toMatchObject({ reasoningEffort: "high" });
    // Another model on another provider is untouched.
    expect(customModelRoute({ model: "custom:ds-1", modelSettings: { effort: "medium" } })).toMatchObject({ reasoningEffort: "medium" });
  });

  it("survive Ash narrowing the levels, and a new chat's default skips them", () => {
    markEffortRefused({ customModelId: "xai-g", effort: "medium" });
    setCustomModelEfforts("xai-g", ["low", "medium", "high"]);
    expect(listCustomModels()[0].refusedEfforts).toEqual(["medium"]);
    const effort = resolveModel("claude", "custom:xai-g").settings![0];
    expect(effort.value).toBe("low");
    expect(effort.options.find((o) => o.value === "medium")).toMatchObject({ unsupported: true });
  });

  it("the chat line is plain words, shown once per chat and level", () => {
    markEffortRefused({ customModelId: "xai-g", effort: "xhigh" });
    const shown = new Set<string>();
    const target = { model: "custom:xai-g", modelSettings: { effort: "xhigh" } };
    expect(effortDroppedNotice(target, shown)).toBe("xAI didn't accept the Extra high level, so this reply used the provider's default.");
    expect(effortDroppedNotice(target, shown)).toBeUndefined();
    expect(effortDroppedNotice({ model: "custom:xai-g", modelSettings: { effort: "high" } }, shown)).toBeUndefined();
    expect(effortDroppedNotice({ model: "claude:opus", modelSettings: { effort: "xhigh" } }, new Set())).toBeUndefined();
    expect(effortDroppedText({ provider: "custom" }, "low")).toBe("Your provider didn't accept the Low level, so this reply used the provider's default.");
  });
});
