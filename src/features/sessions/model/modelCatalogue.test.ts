import { describe, expect, it } from "vitest";
import bundled from "./modelsDev.json";
import { catalogueWindow } from "./modelCatalogue";

const fixture = {
  "DeepSeek-Chat": { context: 128_000, tools: true },
  "deepseek-chat-extra": { context: 256_000, tools: true },
  stringy: { context: "128000", tools: true },
  zero: { context: 0, tools: true },
  negative: { context: -1, tools: true },
  nan: { context: Number.NaN },
  infinite: { context: Number.POSITIVE_INFINITY },
  toolsOnly: { tools: false },
  nested: { context: { tokens: 128_000 } },
  "模型": { context: 8_000, tools: true },
};

describe("catalogueWindow", () => {
  it("matches the exact id, then the same id in another case", () => {
    expect(catalogueWindow("DeepSeek-Chat", fixture)).toBe(128_000);
    expect(catalogueWindow("deepseek-chat", fixture)).toBe(128_000);
    expect(catalogueWindow("  DEEPSEEK-CHAT  ", fixture)).toBe(128_000);
  });

  it("does not take a longer id, a string, or a window that is not a positive finite number", () => {
    expect(catalogueWindow("deepseek", fixture)).toBeUndefined();
    expect(catalogueWindow("deepseek-chat-extra", fixture)).toBe(256_000);
    expect(catalogueWindow("stringy", fixture)).toBeUndefined();
    expect(catalogueWindow("zero", fixture)).toBeUndefined();
    expect(catalogueWindow("negative", fixture)).toBeUndefined();
    expect(catalogueWindow("nan", fixture)).toBeUndefined();
    expect(catalogueWindow("infinite", fixture)).toBeUndefined();
    expect(catalogueWindow("toolsOnly", fixture)).toBeUndefined();
    expect(catalogueWindow("nested", fixture)).toBeUndefined();
  });

  it("ignores an empty id and a catalogue that is not a table", () => {
    expect(catalogueWindow("", fixture)).toBeUndefined();
    expect(catalogueWindow("   ", { " ": { context: 5 } })).toBeUndefined();
    expect(catalogueWindow("DeepSeek-Chat", null)).toBeUndefined();
    expect(catalogueWindow("DeepSeek-Chat", [])).toBeUndefined();
    expect(catalogueWindow("DeepSeek-Chat", "nope")).toBeUndefined();
    expect(catalogueWindow("模型", fixture)).toBe(8_000);
  });

  it("reads a real window out of the bundled file", () => {
    const table = bundled as Record<string, { context?: unknown }>;
    const context = table["deepseek-chat"]?.context;
    expect(typeof context).toBe("number");
    expect(context).toBeGreaterThan(0);
    expect(catalogueWindow("deepseek-chat")).toBe(context);
    expect(catalogueWindow("DEEPSEEK-CHAT")).toBe(context);
  });
});
