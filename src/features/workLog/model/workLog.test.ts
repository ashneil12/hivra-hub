import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  groupLines,
  isDay,
  isTodayQuestion,
  localDay,
  readLines,
  shiftDay,
  todayAnswer,
  withTodayAnswer,
  type WorkLogLine,
} from "./workLog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

import { invoke } from "@tauri-apps/api/core";

function line(part: Partial<WorkLogLine> & Pick<WorkLogLine, "day" | "kind" | "line">): WorkLogLine {
  return { project: "hivra", taskId: "", ...part };
}

const now = new Date(2026, 10, 10, 15, 4, 0);

describe("work log days", () => {
  it("rejects a day that is not on the calendar", () => {
    expect(isDay("2026-11-10")).toBe(true);
    expect(isDay("2024-02-29")).toBe(true);
    expect(isDay("2026-02-31")).toBe(false);
    expect(isDay("2026-11-10 ")).toBe(false);
    expect(isDay("tomorrow")).toBe(false);
    expect(isDay("")).toBe(false);
  });

  it("uses the local calendar day and steps by whole days", () => {
    expect(localDay(now)).toBe("2026-11-10");
    expect(shiftDay("2026-11-10", -6)).toBe("2026-11-04");
    expect(shiftDay("2026-03-01", -6)).toBe("2026-02-23");
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftDay("not-a-day", -1)).toBe("not-a-day");
  });
});

describe("what got done today", () => {
  it("matches the question and nothing wider", () => {
    expect(isTodayQuestion("What got done today?")).toBe(true);
    expect(isTodayQuestion("  what got done today  ")).toBe(true);
    expect(isTodayQuestion("what got done today??")).toBe(true);
    expect(isTodayQuestion("what got done today?\r\n")).toBe(true);
    expect(isTodayQuestion("what got done yesterday")).toBe(false);
    expect(isTodayQuestion("what got done today and why")).toBe(false);
    expect(isTodayQuestion("")).toBe(false);
  });

  it("answers from today's outcomes only", () => {
    const lines = [
      line({ day: "2026-11-09", kind: "outcome", line: "Done: Yesterday." }),
      line({ day: "2026-11-10", kind: "decision", line: "Decided: Ship it. Answer: yes." }),
      line({ day: "2026-11-10", kind: "outcome", line: "Done: Shipped the panel." }),
      line({ day: "2026-11-10", kind: "outcome", project: "other", line: "Done: Other project." }),
      line({ day: "2026-11-10", kind: "feedback", line: "Feedback: keep the line short." }),
    ];
    expect(todayAnswer(lines, "2026-11-10")).toBe("Done: Shipped the panel.\nDone: Other project.");
    expect(todayAnswer(lines.filter((row) => row.project === "hivra"), "2026-11-10")).toBe(
      "Done: Shipped the panel.",
    );
    expect(todayAnswer([], "2026-11-10")).toBe("Nothing got done today.");
    expect(todayAnswer(lines, "2026-11-08")).toBe("Nothing got done today.");
  });

  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockImplementation(async () => []);
  });

  it("leaves the question alone unless it is the one the log answers", async () => {
    await expect(withTodayAnswer("hello", now)).resolves.toBe("hello");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("adds the log's answer, and a failed read is not an empty day", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { project: "hivra", day: "2026-11-10", kind: "outcome", taskId: "t1", line: "Done: Shipped the panel." },
      { project: "hivra", day: "2026-11-10", kind: "nope", line: "Dropped." },
      { day: "2026-11-10", kind: "outcome", line: "Missing a project." },
      null,
    ]);
    await expect(withTodayAnswer("What got done today?", now)).resolves.toBe(
      "What got done today?\n\nAnswer from the work log, not from memory.\nDone: Shipped the panel.",
    );
    expect(invoke).toHaveBeenCalledWith("work_log_read", { day: "2026-11-10" });

    vi.mocked(invoke).mockRejectedValueOnce(new Error("timed out"));
    await expect(withTodayAnswer("What got done today?", now)).resolves.toBe("What got done today?");
  });
});

describe("grouping", () => {
  const lines = [
    line({ day: "2026-11-09", kind: "outcome", line: "Done: Wrote the log." }),
    line({ day: "2026-11-10", kind: "decision", line: "Decided: Ship it. Answer: yes." }),
    line({ day: "2026-11-10", kind: "outcome", line: "Done: Shipped the panel." }),
    line({ day: "2026-11-10", kind: "outcome", project: "other", line: "Done: Other project." }),
    line({ day: "2026-02-31", kind: "outcome", line: "Not a day." }),
  ];

  it("groups by day, newest first, then by kind", () => {
    const groups = groupLines(readLines(lines));
    expect(groups.map((group) => group.day)).toEqual(["2026-11-10", "2026-11-09"]);
    expect(groups[0].kinds.map((kind) => kind.kind)).toEqual(["outcome", "decision"]);
    expect(groups[0].kinds[0].lines.map((row) => row.line)).toEqual([
      "Done: Shipped the panel.",
      "Done: Other project.",
    ]);
  });

  it("a blank project is every project, and a name is exact", () => {
    expect(groupLines(lines, "  ").map((group) => group.day)).toEqual(["2026-11-10", "2026-11-09"]);
    expect(groupLines(lines, "other")).toEqual([
      {
        day: "2026-11-10",
        kinds: [
          {
            kind: "outcome",
            label: "Outcomes",
            lines: [line({ day: "2026-11-10", kind: "outcome", project: "other", line: "Done: Other project." })],
          },
        ],
      },
    ]);
    expect(groupLines(lines, "missing")).toEqual([]);
    expect(groupLines([])).toEqual([]);
  });

  it("drops a row that is not a work log line", () => {
    expect(
      readLines([
        { project: "hivra", day: "2026-11-10", kind: "context", taskId: "t", line: "   " },
        { project: "hivra", day: "tomorrow", kind: "outcome", line: "Done: No." },
        { project: 4, day: "2026-11-10", kind: "outcome", line: "Done: No." },
        "Done: No.",
      ]),
    ).toEqual([]);
  });
});
