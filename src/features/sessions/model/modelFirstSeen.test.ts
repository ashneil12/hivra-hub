// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasListedCatalog,
  hasLiveCatalog,
  MODELS,
  resetHarnessModelOverlays,
  setHarnessModels,
} from "./models";
import {
  BASELINE_DAY,
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
  it("treats the first live snapshot of a harness as a baseline: nothing in it is new", () => {
    recordLiveCatalog("claude", ["claude:opus-5-5", "claude:fable-5"], "2026-11-09");
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-09")).toBe(false);
    expect(isModelNew("claude", "claude:fable-5", "2026-11-09")).toBe(false);
    expect(storedDay("claude", "claude:opus-5-5")).toBe(BASELINE_DAY);
  });

  it("badges a model a later snapshot adds, on the day it first appears", () => {
    recordLiveCatalog("claude", ["claude:opus-5-5"], "2026-11-01");
    recordLiveCatalog("claude", ["claude:opus-5-5", "claude:fable-5-2"], "2026-11-09");
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(true);
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-09")).toBe(false);
  });

  it("badges a model added later the same day the baseline was taken", () => {
    recordLiveCatalog("claude", ["claude:opus-5-5"], "2026-11-09");
    recordLiveCatalog("claude", ["claude:opus-5-5", "claude:fable-5-2"], "2026-11-09");
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(true);
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-09")).toBe(false);
  });

  it("keeps the badge through the seventh day and drops it after that", () => {
    recordLiveCatalog("claude", ["claude:opus-5-5"], "2026-10-20");
    recordLiveCatalog("claude", ["claude:opus-5-5", "claude:fable-5-2"], "2026-11-02");
    expect(NEW_MODEL_DAYS).toBe(7);
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-08")).toBe(true);
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(false);
  });

  it("never badges a baseline model, however often a later snapshot lists it", () => {
    recordLiveCatalog("claude", ["claude:opus-5-5"], "2026-11-01");
    recordLiveCatalog("claude", ["claude:opus-5-5"], "2026-11-09");
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-01")).toBe(false);
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-09")).toBe(false);
    expect(storedDay("claude", "claude:opus-5-5")).toBe(BASELINE_DAY);
  });

  it("gives each harness its own baseline", () => {
    recordLiveCatalog("claude", ["claude:opus-5-5"], "2026-11-01");
    recordLiveCatalog("codex", ["codex:gpt-6"], "2026-11-09");
    expect(isModelNew("codex", "codex:gpt-6", "2026-11-09")).toBe(false);
    recordLiveCatalog("codex", ["codex:gpt-6", "codex:gpt-6.1"], "2026-11-09");
    expect(isModelNew("codex", "codex:gpt-6.1", "2026-11-09")).toBe(true);
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-09")).toBe(false);
  });

  it("does not use an empty snapshot as the baseline", () => {
    recordLiveCatalog("claude", [], "2026-11-01");
    expect(localStorage.getItem(FIRST_SEEN_KEY)).toBeNull();
    recordLiveCatalog("claude", ["claude:opus-5-5"], "2026-11-09");
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-09")).toBe(false);
    recordLiveCatalog("claude", ["claude:opus-5-5", "claude:fable-5-2"], "2026-11-09");
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(true);
  });

  it("makes the first live catalog from setHarnessModels the baseline", () => {
    const bundled = MODELS.find((model) => model.id === "claude:fable-5");
    const other = MODELS.find((model) => model.id === "claude:opus-5-5");
    expect(bundled).toBeDefined();
    expect(other).toBeDefined();
    setHarnessModels("claude", [bundled!]);
    expect(isModelNew("claude", "claude:fable-5", localCalendarDay())).toBe(false);
    setHarnessModels("claude", [bundled!, other!]);
    expect(isModelNew("claude", "claude:opus-5-5", localCalendarDay())).toBe(true);
    expect(isModelNew("claude", "claude:fable-5", localCalendarDay())).toBe(false);
  });

  it("never records a list marked as not live, and the next live list is still the baseline", () => {
    const bundled = MODELS.find((model) => model.id === "claude:fable-5");
    const other = MODELS.find((model) => model.id === "claude:opus-5-5");
    setHarnessModels("claude", [bundled!, other!], { live: false });
    expect(localStorage.getItem(FIRST_SEEN_KEY)).toBeNull();
    expect(isModelNew("claude", "claude:fable-5", localCalendarDay())).toBe(false);
    expect(hasLiveCatalog("claude")).toBe(true);
    expect(hasListedCatalog("claude")).toBe(false);

    setHarnessModels("claude", [bundled!, other!]);
    expect(hasListedCatalog("claude")).toBe(true);
    expect(isModelNew("claude", "claude:fable-5", localCalendarDay())).toBe(false);
    expect(isModelNew("claude", "claude:opus-5-5", localCalendarDay())).toBe(false);
  });

  it("keeps the earlier day when a later refresh or another window writes", () => {
    recordLiveCatalog("claude", ["claude:opus-5"], "2026-10-01");
    recordLiveCatalog("claude", ["claude:opus-5", "claude:fable-5-2"], "2026-11-01");
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
    expect(isModelNew("claude", "claude:fable-5-2", "2026-11-09")).toBe(false);
    recordLiveCatalog("claude", ["claude:fable-5-2", "claude:opus-5-5"], "2026-11-09");
    expect(isModelNew("claude", "claude:opus-5-5", "2026-11-09")).toBe(true);

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
