import { describe, expect, it } from "vitest";
import { liveSettingsChanges } from "./useLiveHarnessSettings";

const lead = {
  id: "lead",
  harness: "claude" as const,
  model: "claude:claude-opus-5-5",
  modelSettings: { effort: "high" },
  runtimeMode: "supervised" as const,
  busy: true,
};

describe("liveSettingsChanges", () => {
  it("reports a change made while a turn runs, once", () => {
    const seen = new Map<string, string>();
    expect(liveSettingsChanges(seen, [lead])).toEqual([]);
    const autopilot = { ...lead, runtimeMode: "full-access" as const };
    expect(liveSettingsChanges(seen, [autopilot])).toEqual([autopilot]);
    expect(liveSettingsChanges(seen, [autopilot])).toEqual([]);
  });

  it("ignores idle sessions, setting order and unrelated changes", () => {
    const seen = new Map<string, string>();
    liveSettingsChanges(seen, [{ ...lead, busy: false }]);
    expect(liveSettingsChanges(seen, [{ ...lead, busy: false, model: "claude:claude-sonnet-5" }])).toEqual([]);
    const reordered = { ...lead, model: "claude:claude-sonnet-5", modelSettings: { effort: "high" } };
    liveSettingsChanges(seen, [reordered]);
    expect(liveSettingsChanges(seen, [{ ...reordered, modelSettings: { ...reordered.modelSettings } }])).toEqual([]);
  });

  it("forgets sessions that are gone", () => {
    const seen = new Map<string, string>();
    liveSettingsChanges(seen, [lead]);
    liveSettingsChanges(seen, []);
    expect(seen.size).toBe(0);
  });
});
