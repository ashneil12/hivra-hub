import { describe, expect, it } from "vitest";
import type { WorkLogLine } from "./workLog";
import {
  correctionTitle,
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
  it("reports the last 7 days and takes no writer, so it cannot apply anything", () => {
    expect(stageRetro).toHaveLength(2);
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
    // Nothing here pretends to be a request to the first mate: the summary has no "ask".
    expect("ask" in result).toBe(false);
    // Only Ash's own correction becomes a proposed edit. Sent back and failed work is counted, not scripted.
    expect(result.pending.map((edit) => edit.text)).toEqual(["Keep the line short."]);
  });

  it("counts sent back and failed work but never turns it into a canned edit", () => {
    const result = stageRetro(
      [
        line("2026-11-09", "outcome", "Sent back: The brief was wrong."),
        line("2026-11-10", "outcome", "Sent back: The brief was thin."),
        line("2026-11-10", "outcome", "Failed: The build broke."),
      ],
      today,
    );
    expect(result.counts).toEqual({ shipped: 0, failed: 1, sentBack: 2, feedback: 0 });
    expect(result.report).toContain("Sent back: 2.");
    expect(result.report).toContain("Failed: 1.");
    expect(result.pending).toEqual([]);
  });

  it("every proposed edit is one of Ash's own correction lines, word for word", () => {
    const corrections = ["Keep the line short.", "Name the file you changed."];
    const result = stageRetro(
      [
        line("2026-11-08", "outcome", "Sent back: The brief was wrong."),
        line("2026-11-09", "outcome", "Failed: The build broke."),
        line("2026-11-09", "feedback", corrections[0]),
        line("2026-11-10", "feedback", corrections[1]),
        line("2026-11-10", "context", "The export is CSV."),
      ],
      today,
    );
    expect(result.pending.map((edit) => edit.text)).toEqual(corrections);
    for (const edit of result.pending) {
      expect(edit.evidence.every((row) => corrections.includes(row.line))).toBe(true);
    }
    const text = JSON.stringify(result.pending);
    expect(text).not.toContain("Check the brief");
    expect(text).not.toContain("Say what broke");
  });

  it("names the log lines behind each edit, and gives an edit an id that follows its words", () => {
    const rows = [
      line("2026-11-09", "outcome", "Sent back: The brief was wrong."),
      line("2026-11-08", "feedback", "Keep the line short."),
      line("2026-11-10", "feedback", "Name the file."),
      line("2026-11-03", "feedback", "Too old to count."),
    ];
    const result = stageRetro(rows, today);
    const byTitle = Object.fromEntries(result.pending.map((edit) => [edit.title, edit]));
    expect(Object.keys(byTitle)).toEqual(["Correction: Keep the line short.", "Correction: Name the file."]);
    expect(byTitle["Correction: Keep the line short."].evidence).toEqual([
      { day: "2026-11-08", line: "Keep the line short." },
    ]);
    const again = stageRetro(rows, today);
    expect(again.pending.map((edit) => edit.id)).toEqual(result.pending.map((edit) => edit.id));
    expect(new Set(result.pending.map((edit) => edit.id)).size).toBe(result.pending.length);
    expect(result.pending.every((edit) => edit.id.startsWith("retro:"))).toBe(true);
    // A different correction is a different edit: the id follows the words.
    const changed = stageRetro(
      rows.map((row) => (row.line === "Name the file." ? { ...row, line: "Name the folder." } : row)),
      today,
    );
    expect(changed.pending[1].id).not.toBe(result.pending[1].id);
    expect(changed.pending[0].id).toBe(result.pending[0].id);
  });

  it("gives every correction a title of its own, cut at a word", () => {
    const long = "Always name the file you changed in the first line of the summary, and never skip it.";
    expect(correctionTitle("Keep the line short.")).toBe("Correction: Keep the line short.");
    const title = correctionTitle(long);
    expect(title).toBe("Correction: Always name the file you changed in the first...");
    expect(title.length).toBeLessThan(70);
    expect(correctionTitle("  Spaced\n  out.  ")).toBe("Correction: Spaced out.");
    const result = stageRetro(
      [line("2026-11-10", "feedback", "Keep the line short."), line("2026-11-10", "feedback", long)],
      today,
    );
    expect(new Set(result.pending.map((edit) => edit.title)).size).toBe(2);
  });

  it("the same correction on two days is one edit with both days behind it", () => {
    const result = stageRetro(
      [
        line("2026-11-08", "feedback", "Keep the line short."),
        line("2026-11-10", "feedback", "Keep the line short."),
        line("2026-11-10", "feedback", "Name the file."),
      ],
      today,
    );
    expect(result.pending.map((edit) => edit.text)).toEqual(["Keep the line short.", "Name the file."]);
    expect(result.pending[0].evidence.map((row) => row.day)).toEqual(["2026-11-08", "2026-11-10"]);
    expect(result.pending[1].evidence).toHaveLength(1);
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
