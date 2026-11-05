import { describe, expect, it } from "vitest";
import { QUIET_MARKER } from "../../monos/model/monoHabits";
import type { Reading } from "./answer";
import { summaryLines, summaryTurnedOff, withDailySummary } from "./summary";

const readings: Reading[] = [
  { kind: "task", id: "task-1", projectId: "crew", text: "Write the notes", stuck: false },
  { kind: "doc", id: "doc-1", projectId: "site", text: "Site spec", stuck: false },
];

describe("summaryLines", () => {
  it("shows linked lines only when there is something to say and the setting is on", () => {
    const report = "task:task-1 notes\ndoc:doc-1 spec\nplain prose with no link";
    expect(summaryLines(report, false, readings).map((line) => line.id)).toEqual(["task-1", "doc-1"]);
    expect(summaryLines(report, true, readings)).toEqual([]);
    expect(summaryLines("", false, readings)).toEqual([]);
    expect(summaryLines(QUIET_MARKER, false, readings)).toEqual([]);
    expect(summaryLines("task:not-real invented", false, readings)).toEqual([]);
    expect(summaryLines(undefined, false, readings)).toEqual([]);
  });

  it("treats only an explicit false as off", () => {
    expect(summaryTurnedOff(false)).toBe(true);
    expect(summaryTurnedOff(undefined)).toBe(false);
    expect(summaryTurnedOff(true)).toBe(false);
    expect(summaryTurnedOff("false")).toBe(false);
    expect(summaryTurnedOff(0)).toBe(false);
  });

  it("stores off as false and drops the flag when turned back on", () => {
    const doc = { savedAt: 1 };
    expect(withDailySummary(doc, false)).toEqual({ savedAt: 1, dailySummary: false });
    expect(withDailySummary({ savedAt: 1, dailySummary: false as const }, true)).toEqual({ savedAt: 1 });
    expect(withDailySummary(doc, true)).toBe(doc);
  });
});
