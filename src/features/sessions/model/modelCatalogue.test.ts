import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import bundled from "./modelsDev.json";
import { catalogueWindow, loadCatalogue } from "./modelCatalogue";

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

  it("reads a real window out of the bundled file once it has loaded", async () => {
    const table = bundled as Record<string, { context?: unknown }>;
    const context = table["deepseek-chat"]?.context;
    expect(typeof context).toBe("number");
    expect(context).toBeGreaterThan(0);
    await loadCatalogue();
    expect(catalogueWindow("deepseek-chat")).toBe(context);
    expect(catalogueWindow("DEEPSEEK-CHAT")).toBe(context);
  });

  it("answers a provider's model from the provider's row, not from whichever provider sorts first", async () => {
    const table = bundled as Record<string, { context?: unknown }>;
    const own = table["deepseek/deepseek-chat"]?.context;
    expect(typeof own).toBe("number");
    await loadCatalogue();
    expect(catalogueWindow("deepseek-chat", undefined, "deepseek")).toBe(own);
  });
});

describe("catalogueWindow with a provider", () => {
  const table = {
    "deepseek/shared": { context: 64_000, tools: true },
    "other/shared": { context: 1_000_000, tools: true },
    shared: { context: 1_000_000, tools: true },
    "deepseek/silent": { tools: true },
    silent: { context: 500_000, tools: true },
    "DeepSeek/Mixed-Case": { context: 32_000, tools: true },
    "mixed-case": { context: 99_000, tools: true },
    lonely: { context: 8_000, tools: true },
    "x-ai/grok-4": { context: 256_000, tools: true },
  };

  it("takes the provider's own row before the bare id", () => {
    expect(catalogueWindow("shared", table, "deepseek")).toBe(64_000);
    expect(catalogueWindow("shared", table, "other")).toBe(1_000_000);
    expect(catalogueWindow("shared", table)).toBe(1_000_000);
  });

  it("matches the provider and the id without regard to case or stray spaces", () => {
    expect(catalogueWindow(" Mixed-Case ", table, " DEEPSEEK ")).toBe(32_000);
  });

  it("falls back to the bare id when the provider has no row for it, or is not a provider models.dev lists", () => {
    expect(catalogueWindow("lonely", table, "deepseek")).toBe(8_000);
    expect(catalogueWindow("lonely", table, "custom")).toBe(8_000);
    expect(catalogueWindow("x-ai/grok-4", table, "openrouter")).toBe(256_000);
    expect(catalogueWindow("lonely", table, "")).toBe(8_000);
  });

  it("does not borrow another provider's window when the provider's row says none", () => {
    expect(catalogueWindow("silent", table, "deepseek")).toBeUndefined();
    expect(catalogueWindow("silent", table)).toBe(500_000);
  });

  it("joins provider and id with one slash and nothing else", () => {
    expect(catalogueWindow("grok-4", table, "x-ai")).toBe(256_000);
    expect(catalogueWindow("grok-4", table)).toBeUndefined();
    expect(catalogueWindow("shared", table, "deepseek/../other")).toBe(1_000_000);
  });
});

describe("the bundled catalogue loads when something asks, not with the module", () => {
  afterEach(() => {
    vi.doUnmock("./modelsDev.json");
    vi.resetModules();
  });

  async function fresh(factory: () => unknown) {
    vi.resetModules();
    vi.doMock("./modelsDev.json", factory);
    return import("./modelCatalogue");
  }

  it("does not read the file until a custom route asks for a window", async () => {
    let reads = 0;
    const mod = await fresh(() => {
      reads += 1;
      return { default: { "deepseek/lazy-model": { context: 77_000, tools: true } } };
    });
    expect(reads).toBe(0);
    expect(mod.catalogueWindow("lazy-model", undefined, "deepseek")).toBeUndefined();
    await mod.loadCatalogue();
    await mod.loadCatalogue();
    expect(reads).toBe(1);
    expect(mod.catalogueWindow("lazy-model", undefined, "deepseek")).toBe(77_000);
  });

  it("no module the app starts with imports the file at the top, where it would come back into the main chunk", () => {
    const src = fileURLToPath(new URL("../../..", import.meta.url));
    const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => /^\s*(import|export)\s[^\n]*modelsDev\.json/m.test(readFileSync(join(src, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("an explicit table never loads the file", async () => {
    let reads = 0;
    const mod = await fresh(() => {
      reads += 1;
      return { default: {} };
    });
    expect(mod.catalogueWindow("x", { x: { context: 5 } })).toBe(5);
    expect(reads).toBe(0);
  });

  it("tells a listener when the file arrives, once", async () => {
    const mod = await fresh(() => ({ default: { m: { context: 9_000 } } }));
    const seen: number[] = [];
    const stop = mod.subscribeCatalogue(() => seen.push(mod.catalogueVersion()));
    expect(mod.catalogueWindow("m")).toBeUndefined();
    await mod.loadCatalogue();
    await mod.loadCatalogue();
    expect(seen).toEqual([1]);
    stop();
  });

  it("a failed load is not final: the next ask tries again", async () => {
    let tries = 0;
    const mod = await fresh(() => {
      tries += 1;
      if (tries === 1) throw new Error("chunk failed to load");
      return { default: { m: { context: 9_000 } } };
    });
    expect(await mod.loadCatalogue()).toBeUndefined();
    expect(mod.catalogueWindow("m")).toBeUndefined();
    await mod.loadCatalogue();
    expect(tries).toBe(2);
    expect(mod.catalogueWindow("m")).toBe(9_000);
  });

  it("a file that is not a table reads as no window, not as a crash", async () => {
    const mod = await fresh(() => ({ default: ["not", "a", "table"] }));
    await mod.loadCatalogue();
    expect(mod.catalogueWindow("not")).toBeUndefined();
  });
});
