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
    expect(withCcStudioModels(catalog)).toEqual(catalog);
  });

  it("retains proxy models when native version filtering hides newer Claude models", () => {
    const catalog = modelsForClaudeVersion("2.1.100");
    expect(catalog.some((model) => model.nativeId === "claude-opus-5-5")).toBe(false);
    for (const model of CC_STUDIO_MODEL_CATALOG) expect(catalog).toContainEqual(model);
  });

  it("passes encoded upstream IDs unchanged to the wrapper without Claude-only settings", () => {
    for (const model of CC_STUDIO_MODEL_CATALOG) {
      expect(model.name).toMatch(/^CC · (OpenCode Go|DeepSeek API) · /);
      expect(model.settings).toBeUndefined();
      const nativeId = resolveClaudeApiModelId(nativeModelId(model));
      const args = buildClaudeSpawnArgs({ model: nativeId, sessionId: "studio-test" });
      expect(args[args.indexOf("--model") + 1]).toBe(model.nativeId);
      expect(nativeId).toMatch(/^ccstudio:(opencode-go|deepseek):/);
    }
  });
});
