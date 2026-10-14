const studioRuntime = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../../../features/providers/model/providerBinaryPaths", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../features/providers/model/providerBinaryPaths")>(),
  isCcStudioClaudeRuntime: () => studioRuntime.enabled,
}));
import { describe, expect, it, vi } from "vitest";
import {
  CC_STUDIO_MODEL_CATALOG,
  modelsForClaudeVersion,
  modelsFromClaudeListModels,
  withCcStudioModels,
} from "./claudeCatalog";
import { buildClaudeSpawnArgs, resolveClaudeApiModelId } from "./claudeProtocol";
import { nativeModelId } from "../../../../features/sessions/model/models";

describe("CC Studio upstream model catalog", () => {
  it("exposes Ultracode as a toggle separate from effort only for native xhigh models", () => {
    const models = modelsForClaudeVersion("2.1.296");
    const opus = models.find((model) => model.nativeId === "claude-opus-5");
    expect(opus?.settings?.find((setting) => setting.id === "ultracode")).toMatchObject({kind: "toggle", value: "false"});
    expect(opus?.settings?.find((setting) => setting.id === "effort")?.options.some((option) => option.value === "ultracode")).toBe(false);
    expect(models.find((model) => model.nativeId === "claude-sonnet-4-6")?.settings?.some((setting) => setting.id === "ultracode")).toBe(false);
    studioRuntime.enabled = true;
  });
  it("omits proxy models when the runtime is stock Claude Code", () => {
    studioRuntime.enabled = false;
    try {
      expect(withCcStudioModels([])).toEqual([]);
      expect(modelsForClaudeVersion("2.1.100").some((model) => model.nativeId?.startsWith("ccstudio:"))).toBe(false);
      expect(() => nativeModelId(CC_STUDIO_MODEL_CATALOG[0])).toThrow("requires the CC Studio Claude launcher");
    } finally { studioRuntime.enabled = true; }
  });
  it("preserves upstream choices when native discovery replaces the catalog", () => {
    const discovered = modelsFromClaudeListModels([
      { value: "sonnet", displayName: "Claude Sonnet" },
    ]);
    const catalog = withCcStudioModels(discovered);
    expect(catalog[0].nativeId).toBe("sonnet");
    expect(catalog.slice(1)).toEqual(CC_STUDIO_MODEL_CATALOG);
    expect(catalog).toHaveLength(4);
    expect(withCcStudioModels([...catalog, {
      id: "claude:ccstudio:grok:grok-4.7-build-fast", harness: "claude", name: "Retired", nativeId: "ccstudio:grok:grok-4.7-build-fast",
    }])).toEqual(catalog);
  });

  it("retains proxy models when native version filtering hides newer Claude models", () => {
    const catalog = modelsForClaudeVersion("2.1.100");
    expect(catalog.some((model) => model.nativeId === "claude-opus-5-5")).toBe(false);
    for (const model of CC_STUDIO_MODEL_CATALOG) expect(catalog).toContainEqual(model);
  });

  it("passes encoded upstream IDs unchanged to the wrapper without Claude-only settings", () => {
    for (const model of CC_STUDIO_MODEL_CATALOG) {
      expect(model.name).toMatch(/^CC · (DeepSeek 4.1 Flash|Grok 4.7|Gemini 4 Argon)/);
      if (model.nativeId === "ccstudio:experiential:deepseek-v4.1-flash") {
        expect(model.settings?.find((setting) => setting.id === "effort")?.options.map((option) => option.value)).toEqual(["low", "high", "max"]);
      } else if (model.nativeId?.startsWith("ccstudio:grok:")) {
        expect(model.settings?.find((setting) => setting.id === "effort")?.options.map((option) => option.value)).toEqual(["low", "medium", "high", "xhigh"]);
      } else expect(model.settings).toBeUndefined();
      expect(model.settings?.some((setting) => ["fast", "context", "ultracode"].includes(setting.id)) ?? false).toBe(false);
      const nativeId = resolveClaudeApiModelId(nativeModelId(model));
      const args = buildClaudeSpawnArgs({ model: nativeId, sessionId: "studio-test" });
      expect(args[args.indexOf("--model") + 1]).toBe(model.nativeId);
      expect(nativeId).toMatch(/^ccstudio:(experiential|grok):/);
    }
  });
});
