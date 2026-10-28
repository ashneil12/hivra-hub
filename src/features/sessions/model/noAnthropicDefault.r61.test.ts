// @vitest-environment happy-dom
// r61 (Alfred): the real app still stored `claude:sonnet-5` as its default model, which no bridge runs and which could
// reach Ash's Claude subscription. Claude Code's default is the bridge's Grok 4.7, and a stored Anthropic default is
// rewritten to it once; other providers' choices are left alone.
import { beforeEach, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, defaultModelId, loadDefaultModels, loadLastModelChoice, preferredModelId, resetHarnessModelOverlays, setHarnessModels } from "./models";
import { loadProjectProviderSettings } from "./projectProviders";

beforeEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
});

it("Claude Code's default is Grok 4.7 on the bridge, even when a live catalog lists Anthropic's models", () => {
  expect(DEFAULT_MODEL_ID.claude).toBe("claude:grok-4.7");
  setHarnessModels("claude", [{ id: "claude:sonnet-5", harness: "claude", name: "Sonnet 5", nativeId: "claude-sonnet-5" }]);
  expect(defaultModelId("claude")).toBe("claude:grok-4.7");
});

it("a stored claude:sonnet-5 default and last choice are migrated to Grok 4.7 and written back; DeepSeek and other providers stay", () => {
  localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5", cursor: "cursor:composer-2.5" }));
  localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:opus-5" }));
  expect(loadDefaultModels()).toEqual({ claude: "claude:grok-4.7", cursor: "cursor:composer-2.5" });
  expect(JSON.parse(localStorage.getItem("monocode.defaultModels")!)).toEqual({ claude: "claude:grok-4.7", cursor: "cursor:composer-2.5" });
  expect(loadLastModelChoice()).toEqual({ harness: "claude", model: "claude:grok-4.7" });
  expect(JSON.parse(localStorage.getItem("monocode.lastModel")!).model).toBe("claude:grok-4.7");
  expect(preferredModelId("claude")).toBe("claude:grok-4.7");
  localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:deepseek-v4.1-flash" }));
  expect(loadDefaultModels()).toEqual({ claude: "claude:deepseek-v4.1-flash" });
});

it("a project's stored Claude default reads as Grok 4.7 too", () => {
  localStorage.setItem("monocode.projectProviderSettings.v1", JSON.stringify({
    "/Users/example/Projects/p": { defaultHarness: "claude", defaultModel: "claude:sonnet-5", models: { claude: "sonnet", grok: "grok:grok-4.6" } },
  }));
  const settings = loadProjectProviderSettings("/Users/example/Projects/p");
  expect(settings).toMatchObject({ defaultModel: "claude:grok-4.7", models: { claude: "claude:grok-4.7", grok: "grok:grok-4.6" } });
});
