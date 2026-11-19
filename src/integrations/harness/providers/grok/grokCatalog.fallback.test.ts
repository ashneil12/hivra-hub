// @vitest-environment happy-dom
// Grok's built-in list fills the picker when Grok will not list its models, but it is never recorded as a
// live catalog: it cannot become the baseline or make a model look new.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Mode = "listed" | "fallback";
let mode: Mode = "fallback";

vi.mock("../../core/child", () => ({
  resolveGrokBinary: async () => {
    if (mode === "fallback") throw new Error("stand-in: grok is not installed");
    return { path: "/fake/grok" };
  },
  // The ACP probe cannot start, so the CLI's `models` command is the one that answers.
  spawnChild: async () => {
    throw new Error("stand-in: no ACP probe");
  },
  execChild: async () =>
    "Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n  - grok-5\n",
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: () => undefined,
  writeChild: async () => undefined,
}));
vi.mock("../../../../platform/tauri/fs", () => ({ homeDir: async () => "/home/tester" }));

import {
  hasListedCatalog,
  hasLiveCatalog,
  modelsFor,
  resetHarnessModelOverlays,
} from "../../../../features/sessions/model/models";
import {
  FIRST_SEEN_KEY,
  isModelNew,
  localCalendarDay,
} from "../../../../features/sessions/model/modelFirstSeen";
import { refreshGrokCatalog } from "./grokCatalog";

beforeEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
});

afterEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
});

describe("refreshGrokCatalog", () => {
  it("fills the picker from the built-in list when Grok will not list, and records nothing as live", async () => {
    mode = "fallback";
    await refreshGrokCatalog();

    expect(modelsFor("grok").map((m) => m.nativeId)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(hasLiveCatalog("grok")).toBe(true);
    expect(hasListedCatalog("grok")).toBe(false);
    expect(localStorage.getItem(FIRST_SEEN_KEY)).toBeNull();
  });

  it("takes the first list Grok gives as the baseline", async () => {
    mode = "listed";
    await refreshGrokCatalog();

    expect(modelsFor("grok").map((m) => m.nativeId)).toEqual(["grok-4.6", "grok-4.5", "grok-5"]);
    expect(hasListedCatalog("grok")).toBe(true);
    expect(localStorage.getItem(FIRST_SEEN_KEY)).not.toBeNull();
    for (const id of ["grok:grok-4.6", "grok:grok-4.5", "grok:grok-5"]) {
      expect(isModelNew("grok", id, localCalendarDay())).toBe(false);
    }
  });

  it("a built-in list shown first does not stop the next real list from being the baseline", async () => {
    mode = "fallback";
    await refreshGrokCatalog();
    mode = "listed";
    await refreshGrokCatalog();

    expect(hasListedCatalog("grok")).toBe(true);
    expect(isModelNew("grok", "grok:grok-5", localCalendarDay())).toBe(false);
  });
});
