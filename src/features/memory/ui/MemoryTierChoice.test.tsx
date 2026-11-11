// WP-103: Settings > Memory offers three ways to remember, in plain words, and saves the one picked.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryTierChoice, type TierModel } from "./MemoryTierChoice";

const MODELS: TierModel[] = [
  { id: "xai-abc123", name: "Grok fast" },
  { id: "deepseek-def456", name: "DeepSeek chat" },
];

function html(value: Parameters<typeof MemoryTierChoice>[0]["value"], models: TierModel[] = MODELS): string {
  return renderToStaticMarkup(createElement(MemoryTierChoice, { value, models, onChange: () => undefined }));
}

describe("the memory tier choice", () => {
  it("offers the three tiers in plain words, with what each costs", () => {
    const text = html({ tier: "crew" });
    expect(text).toContain("Rules on this Mac");
    expect(text).toContain("Nothing leaves this Mac.");
    expect(text).toContain("A cheap model");
    expect(text).toContain("billed by its provider");
    expect(text).toContain("Your crew");
    expect(text).toContain("your crew&#x27;s signed-in CLI");
    expect(text).toContain("comes out of your plan");
    // No jargon: no "provider" as the only word for the CLI, no model tier names a person would need decoding.
    expect(text).not.toMatch(/tier [123]|LLM|inference/i);
  });

  it("marks the saved tier as the selected one", () => {
    const crew = html({ tier: "crew" });
    expect(crew).toMatch(/data-tier="crew"[^]*?<input[^>]*checked=""/);
    const rules = html({ tier: "rules" });
    expect(rules).toMatch(/data-tier="rules"[^]*?<input[^>]*checked=""/);
    expect(rules).not.toMatch(/data-tier="crew"[^]*?<input[^>]*checked=""/);
  });

  it("shows the model picker only on the cheap tier, with the models already added", () => {
    expect(html({ tier: "rules" })).not.toContain("The model to use");
    expect(html({ tier: "crew" })).not.toContain("The model to use");
    const cheap = html({ tier: "cheap", model: "deepseek-def456" });
    expect(cheap).toContain("The model to use");
    expect(cheap).toContain("Grok fast");
    expect(cheap).toContain("DeepSeek chat");
    expect(cheap).toMatch(/<option[^>]*value="deepseek-def456"[^>]*selected=""/);
  });

  it("shows the address beside a model only when it goes somewhere other than the provider's default", () => {
    const cheap = html({ tier: "cheap", model: "xai-abc123" }, [
      { id: "xai-abc123", name: "Grok fast", provider: "xai", baseUrl: "https://api.x.ai/v1" },
      { id: "deepseek-def456", name: "DeepSeek chat", provider: "deepseek", baseUrl: "https://proxy.example.com/v1" },
    ]);
    expect(cheap).toContain("DeepSeek chat · https://proxy.example.com/v1");
    expect(cheap).not.toContain("https://api.x.ai/v1");
    expect(cheap).toContain(">Grok fast<");
  });

  it("says what to do when the cheap tier is picked and no model has been added", () => {
    expect(html({ tier: "cheap" }, [])).toContain("Add a model under Other models first");
  });

  it("shows a half-point when the picked model was removed", () => {
    const gone = html({ tier: "cheap", model: "xai-gone" });
    expect(gone).toContain("Pick a model");
    expect(gone).not.toMatch(/value="xai-gone"[^>]*selected=""/);
  });

  it("says a change starts with the next turn", () => {
    expect(html({ tier: "rules" })).toContain("A change starts with your next turn.");
  });

  it("offers a test of the picked model, and only once one is picked", () => {
    expect(html({ tier: "crew" })).not.toContain("Test this model");
    expect(html({ tier: "cheap", model: "deepseek-def456" })).toContain("Test this model");
    // With the model gone, there is nothing to test yet.
    const gone = renderToStaticMarkup(createElement(MemoryTierChoice, { value: { tier: "cheap", model: "xai-gone" }, models: MODELS, onChange: () => undefined }));
    expect(gone).toContain("Test this model");
    expect(gone).toMatch(/<button[^>]*disabled=""/);
  });
});
