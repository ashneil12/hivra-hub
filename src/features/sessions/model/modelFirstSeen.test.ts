// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODELS, resetHarnessModelOverlays, setHarnessModels } from "./models";
import {
  FIRST_SEEN_KEY,
  isModelNew,
  localCalendarDay,
  NEW_MODEL_DAYS,
  recordLiveCatalog,
} from "./modelFirstSeen";

const realStorage = localStorage;

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: realStorage,
  });
  localStorage.clear();
  resetHarnessModelOverlays();
});

describe("live model first-seen", () => {
  it("badges a model on the day a live catalog first sees it", () => {
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(false);
    recordLiveCatalog("claude", ["claude:fable-5-2"], "2026-11-09");
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(true);
  });

  it("keeps the badge through the seventh day and drops it after that", () => {
    recordLiveCatalog("claude", ["claude:fable-5-2"], "2026-11-02");
    expect(NEW_MODEL_DAYS).toBe(7);
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-08")).toBe(true);
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(false);
  });

  it("does not badge a static fallback model until a live catalog sees it", () => {
    const bundled = MODELS.find((model) => model.id === "claude:fable-5");
    expect(bundled).toBeDefined();
    expect(isModelNew("claude", "claude:fable-5", "2026-11-09")).toBe(false);
    setHarnessModels("claude", [bundled!]);
    expect(isModelNew("claude", "claude:fable-5", localCalendarDay())).toBe(true);
  });

  it("keeps the earlier day when a later refresh or another window writes", () => {
    recordLiveCatalog("claude", ["claude:fable-5-2"], "2026-11-01");
    recordLiveCatalog("claude", ["claude:fable-5-2", "claude:opus-5-5"], "2026-11-09");
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(false);
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-09")).toBe(true);

    recordLiveCatalog("claude", ["claude:opus-5-5"], "2026-11-08");
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-09")).toBe(true);
    expect(storedDay("claude", "claude:opus-5-5")).toBe("2026-11-08");
  });

  it("ignores empty ids, duplicates, and a stored value that is not a day", () => {
    localStorage.setItem(
      FIRST_SEEN_KEY,
      JSON.stringify({
        claude: { "claude:kept": "not-a-day", "claude:old": "2026-11-01" },
        grok: { "grok:grok-4.6": "2026-11-09" },
      }),
    );
    recordLiveCatalog(
      "claude",
      ["", "claude:kept", "claude:kept", "claude:new"],
      "2026-11-09",
    );
    expect(storedDay("claude", "claude:kept")).toBe("2026-11-09");
    expect(storedDay("claude", "claude:old")).toBe("2026-11-01");
    expect(storedDay("claude", "claude:new")).toBe("2026-11-09");
    expect(storedDay("grok", "grok:grok-4.6")).toBe("2026-11-09");
    expect(storedDay("claude", "")).toBeUndefined();
  });

  it("drops corrupt storage and a store that throws", () => {
    localStorage.setItem(FIRST_SEEN_KEY, "{");
    expect(() =>
      recordLiveCatalog("claude", ["claude:fable-5-2"], "2026-11-09"),
    ).not.toThrow();
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(true);

    const broken = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
      clear() {
        throw new Error("denied");
      },
      key() {
        return null;
      },
      length: 0,
    };
    viStubStorage(broken);
    expect(() =>
      recordLiveCatalog("claude", ["claude:other"], "2026-11-09"),
    ).not.toThrow();
    expect(isModelNew("claude", "claude:other", "2026-11-09")).toBe(false);
  });

  it("does not record an empty live catalog", () => {
    setHarnessModels("claude", []);
    expect(localStorage.getItem(FIRST_SEEN_KEY)).toBeNull();
  });
});

function storedDay(harness: string, id: string): string | undefined {
  const raw = localStorage.getItem(FIRST_SEEN_KEY);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
  return parsed[harness]?.[id];
}

function viStubStorage(storage: Storage): void {
  vi.stubGlobal("localStorage", storage);
}
