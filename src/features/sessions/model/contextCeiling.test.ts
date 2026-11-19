import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextCeilingFor,
  warmContextCeiling,
  effectiveContextWindow,
  formatDuration,
  idleCompactionDue,
  loadContextCeilingChoice,
  saveContextCeilingChoice,
} from "./contextCeiling";
import { rotationReason } from "../../monos/model/monoRotation";
import bundled from "./modelsDev.json";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

beforeEach(() => storage.clear());

describe("context ceiling", () => {
  it("defaults per model family, and only for Claude Code", () => {
    expect(contextCeilingFor({ harness: "claude", model: "claude:claude-opus-5-5" })).toBe(350_000);
    expect(contextCeilingFor({ harness: "claude", model: "claude:claude-sonnet-5" })).toBe(400_000);
    expect(contextCeilingFor({ harness: "claude", model: "claude:claude-haiku-4-5" })).toBe(400_000);
    expect(contextCeilingFor({ harness: "codex", model: "gpt-5" })).toBeUndefined();
  });

  it("asks the bundled catalogue before the family ceiling, and only for a custom model", () => {
    const catalogue = {
      "widget-7": { context: 128_000, tools: true },
      "claude-opus-5-5": { context: 180_000, tools: true },
      "claude:claude-opus-5-5": { context: 180_000, tools: true },
      tiny: { context: 50_000, tools: false },
      huge: { context: 1_500_000, tools: true },
      stringy: { context: "128000", tools: true },
    };
    const save = (id: string, modelId: string) =>
      storage.set(
        "monocode:custom-models",
        JSON.stringify([{ id, name: id, provider: "custom", baseUrl: "http://127.0.0.1:9/v1", modelId }]),
      );
    save("m1", "widget-7");
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "model", catalogue)).toBe(128_000);
    save("m1", "tiny");
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "model", catalogue)).toBe(100_000);
    save("m1", "huge");
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "model", catalogue)).toBe(1_000_000);
    save("m1", "claude-opus-5-5");
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "model", catalogue)).toBe(180_000);
    save("m1", "stringy");
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "model", catalogue)).toBe(400_000);
    save("m1", "widget-opus");
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "model", {})).toBe(350_000);
    save("m1", "widget-7");
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "model", {})).toBe(400_000);
    expect(contextCeilingFor({ harness: "claude", model: "claude:claude-opus-5-5" }, "model", catalogue)).toBe(350_000);
    expect(contextCeilingFor({ harness: "codex", model: "custom:m1" }, "model", catalogue)).toBeUndefined();
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, 300_000, catalogue)).toBe(300_000);
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "off", catalogue)).toBeUndefined();
    expect(contextCeilingFor({ harness: "claude", model: "custom:missing" }, "model", catalogue)).toBe(400_000);
  });

  it("asks for the model's own provider's window before the bare id", () => {
    const catalogue = {
      "deepseek/widget-9": { context: 64_000, tools: true },
      "widget-9": { context: 1_000_000, tools: true },
    };
    const save = (provider: string) =>
      storage.set(
        "monocode:custom-models",
        JSON.stringify([{ id: "m1", name: "m1", provider, baseUrl: "http://127.0.0.1:9/v1", modelId: "widget-9" }]),
      );
    save("deepseek");
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "model", catalogue)).toBe(100_000);
    save("custom");
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" }, "model", catalogue)).toBe(1_000_000);
  });

  it("reads the bundled file once a custom route has asked for it, and a turn waits for it", async () => {
    storage.set(
      "monocode:custom-models",
      JSON.stringify([
        { id: "m1", name: "m1", provider: "deepseek", baseUrl: "http://127.0.0.1:9/v1", modelId: "deepseek-chat" },
      ]),
    );
    // Asking starts the load. The family ceiling answers until it lands.
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" })).toBe(400_000);
    await warmContextCeiling("custom:m1");
    // DeepSeek's own row for deepseek-chat, not the bare id another provider put first.
    const table = bundled as Record<string, { context: number }>;
    const own = table["deepseek/deepseek-chat"].context;
    expect(own).not.toBe(table["deepseek-chat"].context);
    expect(contextCeilingFor({ harness: "claude", model: "custom:m1" })).toBe(Math.min(own, 1_000_000));
    expect(contextCeilingFor({ harness: "claude", model: "claude:claude-opus-5-5" })).toBe(350_000);
  });

  it("a Claude model's turn does not wait for, or load, the catalogue", async () => {
    vi.resetModules();
    const catalogue = await import("./modelCatalogue");
    const ceiling = await import("./contextCeiling");
    await ceiling.warmContextCeiling("claude:claude-opus-5-5");
    await ceiling.warmContextCeiling("custom:missing");
    expect(catalogue.catalogueVersion()).toBe(0);
  });

  it("takes the Settings choice, and nothing for Claude Code's default", () => {
    saveContextCeilingChoice(300_000);
    expect(loadContextCeilingChoice()).toBe(300_000);
    expect(contextCeilingFor({ harness: "claude", model: "claude:claude-opus-5-5" })).toBe(300_000);
    saveContextCeilingChoice("off");
    expect(contextCeilingFor({ harness: "claude", model: "claude:claude-opus-5-5" })).toBeUndefined();
    storage.set("monocode.contextCeiling", "12345");
    expect(loadContextCeilingChoice()).toBe("model");
  });

  it("is capped by a smaller window", () => {
    expect(effectiveContextWindow(1_000_000, 350_000)).toBe(350_000);
    expect(effectiveContextWindow(200_000, 350_000)).toBe(200_000);
    expect(effectiveContextWindow(undefined, 350_000)).toBeUndefined();
  });
});

describe("Mono rotation under the ceiling", () => {
  const session = (used: number, window = 1_000_000) => ({
    providerSessionId: "p1",
    context: { used, window },
    blocks: [],
    harness: "claude" as const,
    model: "claude:claude-opus-5-5",
  });

  it("rotates at 80% of the ceiling on a 1M window, before Claude Code would compact", () => {
    expect(rotationReason(session(270_000))).toBeUndefined();
    expect(rotationReason(session(280_000))).toBe("context");
  });

  it("keeps 80% of the window where the window is smaller, and for other harnesses", () => {
    expect(rotationReason(session(150_000, 200_000))).toBeUndefined();
    expect(rotationReason(session(160_000, 200_000))).toBe("context");
    expect(rotationReason({ ...session(700_000), harness: "codex" })).toBeUndefined();
    expect(rotationReason({ ...session(800_000), harness: "codex" })).toBe("context");
  });
});

describe("idle compaction", () => {
  const hour = 60 * 60_000;
  const minute = 60_000;
  it("is due for a big chat idle past its cache lifetime", () => {
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 300_000 }, hour + 1, true)).toEqual({
      idleMs: hour + 1,
      ttlMs: hour,
      used: 300_000,
      expired: true,
    });
  });

  it("is due one minute before a one hour cache expires, including at exactly 100K", () => {
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 300_000 }, hour - minute, true)).toEqual({
      idleMs: hour - minute,
      ttlMs: hour,
      used: 300_000,
      expired: false,
    });
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 100_000 }, hour - minute, true)?.expired).toBe(false);
  });

  it("is due at the moment a one hour cache expires, but that is not the on-send fallback", () => {
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 300_000 }, hour, true)).toEqual({
      idleMs: hour,
      ttlMs: hour,
      used: 300_000,
      expired: false,
    });
  });

  it("is not due two minutes before a one hour cache, under 100K, with nothing known, or switched off", () => {
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 300_000 }, hour - 2 * minute, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 99_000 }, 2 * hour, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 99_000 }, hour - minute, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 0, contextUsed: 300_000 }, 2 * hour, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 1, cacheTtlMs: hour, contextUsed: 300_000 }, hour - minute, false)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: Number.NaN, cacheTtlMs: hour, contextUsed: 300_000 }, hour, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: Number.NaN, contextUsed: 300_000 }, hour, true)).toBeNull();
  });

  it("uses half the lifetime when the cache itself lasts under two minutes", () => {
    const ttl = 90_000;
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: ttl, contextUsed: 300_000 }, ttl / 2, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: ttl, contextUsed: 300_000 }, ttl / 2 + 1, true)).toMatchObject({
      expired: false,
    });
  });

  it("gives a five minute cache the same two minute lead", () => {
    const ttl = 5 * minute;
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: ttl, contextUsed: 300_000 }, 3 * minute, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: ttl, contextUsed: 300_000 }, 3 * minute + 1, true)).toMatchObject({
      ttlMs: ttl,
      expired: false,
    });
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: ttl, contextUsed: 300_000 }, ttl + 1, true)?.expired).toBe(true);
  });

  it("formats durations for the note", () => {
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(hour)).toBe("1 h");
    expect(formatDuration(2 * hour + 10 * 60_000)).toBe("2 h 10 min");
  });
});
