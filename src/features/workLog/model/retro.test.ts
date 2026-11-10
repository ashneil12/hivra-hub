import { describe, expect, it, vi } from "vitest";
import type { WorkLogLine } from "./workLog";
import {
  acceptEdit,
  defaultWeeklyRetro,
  markAsked,
  parseWeeklyRetro,
  stageRetro,
  weeklyRetroDue,
} from "./retro";

function line(day: string, kind: WorkLogLine["kind"], text: string): WorkLogLine {
  return { project: "hivra", day, kind, taskId: "", line: text };
}

const today = "2026-11-10";

describe("retro", () => {
  it("reports the last 7 days and does not apply anything", () => {
    const apply = vi.fn();
    const result = stageRetro(
      [
        line("2026-11-03", "outcome", "Done: Too old."),
        line("2026-11-04", "outcome", "Done: Still in the week."),
        line("2026-11-09", "outcome", "Failed: The build broke."),
        line("2026-11-10", "outcome", "Sent back: The brief was wrong."),
        line("2026-11-10", "outcome", "Done: Shipped the panel."),
        line("2026-11-10", "decision", "Decided: Ship it. Answer: yes."),
        line("2026-11-10", "feedback", "Keep the line short."),
      ],
      today,
    );
    expect(result.applied).toBe(false);
    expect(result.from).toBe("2026-11-04");
    expect(result.to).toBe("2026-11-10");
    expect(result.counts).toEqual({ shipped: 2, failed: 1, sentBack: 1, feedback: 1 });
    expect(result.shipped).toEqual(["Done: Still in the week.", "Done: Shipped the panel."]);
    expect(result.report).toContain("Shipped: 2.");
    expect(result.report).toContain("Sent back: 1.");
    expect(result.ask).toContain("at most 5");
    expect(result.ask).toContain("Do not apply");
    expect(result.pending.map((edit) => edit.text)).toEqual([
      "Keep the line short.",
      "Work was sent back 1 time this week. Check the brief before the next try.",
      "1 task failed this week. Say what broke, in one line.",
    ]);
    expect(apply).not.toHaveBeenCalled();
    acceptEdit(result.pending[0], apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("keeps at most 5 edits, and an empty week changes nothing", () => {
    const feedback = Array.from({ length: 6 }, (_, index) =>
      line("2026-11-10", "feedback", `Correction ${index}.`),
    );
    const result = stageRetro(
      [...feedback, line("2026-11-10", "outcome", "Sent back: Again.")],
      today,
    );
    expect(result.pending).toHaveLength(5);
    expect(result.pending.every((edit) => edit.text.startsWith("Correction"))).toBe(true);
    expect(result.applied).toBe(false);

    const empty = stageRetro([], today);
    expect(empty.counts.shipped).toBe(0);
    expect(empty.pending).toEqual([]);
    expect(empty.applied).toBe(false);
    expect(empty.report).toContain("Nothing shipped.");
  });

  it("a bad day is not a retro", () => {
    const result = stageRetro([line("2026-11-10", "outcome", "Done: Shipped.")], "tomorrow");
    expect(result.pending).toEqual([]);
    expect(result.applied).toBe(false);
    expect(result.report).toBe("The day should look like 2026-11-10.");
  });
});

describe("weekly retro", () => {
  it("is off unless it was turned on, and a bad save stays off", () => {
    expect(defaultWeeklyRetro()).toEqual({ enabled: false, lastAskedAt: null });
    expect(parseWeeklyRetro(null)).toEqual({ enabled: false, lastAskedAt: null });
    expect(parseWeeklyRetro({ enabled: "yes", lastAskedAt: "yesterday" })).toEqual({
      enabled: false,
      lastAskedAt: null,
    });
    expect(parseWeeklyRetro({ enabled: true, lastAskedAt: "2026-11-03T00:00:00.000Z" })).toEqual({
      enabled: true,
      lastAskedAt: "2026-11-03T00:00:00.000Z",
    });
    expect(weeklyRetroDue(defaultWeeklyRetro(), Date.parse("2026-11-10T00:00:00.000Z"))).toBe(false);
    expect(weeklyRetroDue({ enabled: true, lastAskedAt: null }, Date.parse("2026-11-10T00:00:00.000Z"))).toBe(true);
    const recent = { enabled: true, lastAskedAt: "2026-11-09T00:00:00.000Z" };
    expect(weeklyRetroDue(recent, Date.parse("2026-11-10T00:00:00.000Z"))).toBe(false);
    expect(weeklyRetroDue(recent, Date.parse("2026-11-16T00:00:00.000Z"))).toBe(true);
  });

  it("turning it on does not ask, and asking remembers the day", () => {
    const on = markAsked({ enabled: true, lastAskedAt: null }, "not-a-time");
    expect(on).toEqual({ enabled: true, lastAskedAt: null });
    const asked = markAsked({ enabled: true, lastAskedAt: null }, "2026-11-10T00:00:00.000Z");
    expect(asked.lastAskedAt).toBe("2026-11-10T00:00:00.000Z");
    expect(markAsked(defaultWeeklyRetro(), "2026-11-10T00:00:00.000Z")).toEqual(defaultWeeklyRetro());
  });
});
