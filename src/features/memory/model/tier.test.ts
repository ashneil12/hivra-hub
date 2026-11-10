// @vitest-environment happy-dom
// WP-103: how Hivra remembers. Tests first. Old settings have no tier at all and read as crew.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_TIER_KEY,
  loadMemoryTier,
  readMemoryTier,
  saveMemoryTier,
  snapshotMemoryTier,
  subscribeMemoryTier,
  tierLabel,
  tierSendsText,
} from "./tier";

beforeEach(() => localStorage.clear());

describe("the tier setting", () => {
  it("is crew when nothing has been chosen, so nothing changes for existing people", () => {
    expect(loadMemoryTier()).toEqual({ tier: "crew" });
    expect(readMemoryTier(undefined)).toEqual({ tier: "crew" });
    expect(readMemoryTier(null)).toEqual({ tier: "crew" });
    expect(readMemoryTier("")).toEqual({ tier: "crew" });
  });

  it("keeps each of the three tiers, and the cheap tier's model", () => {
    saveMemoryTier({ tier: "rules" });
    expect(loadMemoryTier()).toEqual({ tier: "rules" });
    saveMemoryTier({ tier: "cheap", model: "xai-abc123" });
    expect(loadMemoryTier()).toEqual({ tier: "cheap", model: "xai-abc123" });
    saveMemoryTier({ tier: "crew" });
    expect(loadMemoryTier()).toEqual({ tier: "crew" });
  });

  it("reads a bare tier name, which an older build could have written", () => {
    localStorage.setItem(MEMORY_TIER_KEY, JSON.stringify("rules"));
    expect(loadMemoryTier()).toEqual({ tier: "rules" });
  });

  it("falls back to crew for a value it cannot read, and never throws", () => {
    for (const bad of ["{", "[]", "42", "true", JSON.stringify({ tier: "model" }), JSON.stringify({ tier: 3 })]) {
      localStorage.setItem(MEMORY_TIER_KEY, bad);
      expect(loadMemoryTier(), bad).toEqual({ tier: "crew" });
    }
  });

  it("drops a model it cannot read, and a model on a tier that does not use one", () => {
    expect(readMemoryTier({ tier: "cheap", model: 42 })).toEqual({ tier: "cheap" });
    expect(readMemoryTier({ tier: "cheap", model: "Bad Model!/.." })).toEqual({ tier: "cheap" });
    expect(readMemoryTier({ tier: "cheap", model: "sk-ant-api03-abcdefghijklmnopqrst" })).toEqual({ tier: "cheap" });
    expect(readMemoryTier({ tier: "crew", model: "xai-abc123" })).toEqual({ tier: "crew" });
    expect(readMemoryTier({ tier: "rules", model: "xai-abc123" })).toEqual({ tier: "rules" });
  });

  it("tells the person what each tier sends", () => {
    expect(tierSendsText("rules")).toBe(false);
    expect(tierSendsText("cheap")).toBe(true);
    expect(tierSendsText("crew")).toBe(true);
    expect(tierLabel("rules")).toBe("Rules on this Mac");
    expect(tierLabel("cheap")).toBe("A cheap model");
    expect(tierLabel("crew")).toBe("Your crew");
  });

  it("gives a render the same value until the setting actually moves", () => {
    // React's useSyncExternalStore reads this on every render and loops forever on a value that is always new.
    const first = snapshotMemoryTier();
    expect(snapshotMemoryTier()).toBe(first);
    expect(snapshotMemoryTier()).toBe(snapshotMemoryTier());
    saveMemoryTier({ tier: "cheap", model: "xai-abc123" });
    expect(snapshotMemoryTier()).toEqual({ tier: "cheap", model: "xai-abc123" });
    const after = snapshotMemoryTier();
    expect(snapshotMemoryTier()).toBe(after);
    // Another window's write also moves it.
    localStorage.setItem(MEMORY_TIER_KEY, JSON.stringify({ tier: "rules" }));
    expect(snapshotMemoryTier()).toEqual({ tier: "rules" });
  });

  it("hears a save from this window and from another one", () => {
    const heard = vi.fn();
    const stop = subscribeMemoryTier(heard);
    saveMemoryTier({ tier: "rules" });
    expect(heard).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key: MEMORY_TIER_KEY }));
    expect(heard).toHaveBeenCalledTimes(2);
    // A save to another key is not this setting.
    window.dispatchEvent(new StorageEvent("storage", { key: "monocode.other" }));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    saveMemoryTier({ tier: "crew" });
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
