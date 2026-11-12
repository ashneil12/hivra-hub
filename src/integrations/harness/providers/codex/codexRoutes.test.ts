import { afterEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ list: [] as Array<{ provider: string; baseUrl: string; modelId: string; customModelId: string }> }));
vi.mock("../../../../features/sessions/model/customModels", () => ({
  piModelRoutes: () => saved.list,
}));

import { codexModelRoutes, codexRoutedModels, offeredRoutes, routedProviderName, splitRoutedModel } from "./codexRoutes";

describe("codexRoutes", () => {
  afterEach(() => {
    saved.list = [];
  });

  it("names providers the way Rust does", () => {
    expect(routedProviderName("Grok_4.7")).toBe("dropwave-grok-4-7");
  });

  it("offers Codex only providers that speak OpenAI Responses", () => {
    saved.list = [
      { provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.7", customModelId: "grok" },
      { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat", customModelId: "ds" },
    ];
    expect(codexModelRoutes().map((r) => r.customModelId)).toEqual(["grok"]);
    expect(codexRoutedModels()).toEqual([
      {
        id: "codex:dropwave-grok/grok-4.7",
        harness: "codex",
        name: "grok-4.7 (your key)",
        nativeId: "dropwave-grok/grok-4.7",
        provider: { id: "dropwave-grok", name: "Your saved models" },
      },
    ]);
  });

  it("splits a saved model into Codex's provider and model, and leaves Codex's own alone", () => {
    expect(splitRoutedModel("dropwave-grok/grok-4.7")).toEqual({ provider: "dropwave-grok", model: "grok-4.7" });
    expect(splitRoutedModel("gpt-5.5")).toEqual({ model: "gpt-5.5" });
    expect(splitRoutedModel(undefined)).toEqual({ model: undefined });
  });
});

describe("offeredRoutes", () => {
  it("keeps the first of two ids with the same provider name and at most 16, as Rust does", () => {
    const routes = [{ customModelId: "a.b" }, { customModelId: "a_b" }, ...Array.from({ length: 20 }, (_, i) => ({ customModelId: `m${i}` }))];
    const out = offeredRoutes(routes);
    expect(out[0]).toEqual({ customModelId: "a.b" });
    expect(out.some((r) => r.customModelId === "a_b")).toBe(false);
    expect(out).toHaveLength(16);
  });

  it("names a character outside the BMP with one dash, like Rust", () => {
    expect(routedProviderName("x😀y")).toBe("dropwave-x-y");
  });
});
