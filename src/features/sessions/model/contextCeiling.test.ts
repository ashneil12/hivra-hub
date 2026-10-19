import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextCeilingFor,
  effectiveContextWindow,
  formatDuration,
  idleCompactionDue,
  loadContextCeilingChoice,
  saveContextCeilingChoice,
} from "./contextCeiling";
import { rotationReason } from "../../monos/model/monoRotation";

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
  it("is due for a big chat idle past its cache lifetime", () => {
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 300_000 }, hour + 1, true)).toEqual({
      idleMs: hour + 1,
      ttlMs: hour,
      used: 300_000,
    });
  });

  it("is not due inside the lifetime, under 100K, with nothing known, or switched off", () => {
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 300_000 }, hour, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 0, cacheTtlMs: hour, contextUsed: 99_000 }, 2 * hour, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 0, contextUsed: 300_000 }, 2 * hour, true)).toBeNull();
    expect(idleCompactionDue({ lastTurnAt: 1, cacheTtlMs: hour, contextUsed: 300_000 }, 3 * hour, false)).toBeNull();
  });

  it("formats durations for the note", () => {
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(hour)).toBe("1 h");
    expect(formatDuration(2 * hour + 10 * 60_000)).toBe("2 h 10 min");
  });
});
