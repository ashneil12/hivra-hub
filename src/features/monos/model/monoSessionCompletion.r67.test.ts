// r67 (realconv S8 on 0.16.8, run b158): with six tracks out, the Tally lead opened each partial report with the same
// verify-first line ("X is back. I'll check the commit myself before calling that one done.", three times) and then
// posted every track's detail as it came in (+424 s wall). The report asks for silent checks, one or two lines while
// work still runs, and one roll-up in the Landed / Not fixed shape when all are back.
import { describe, expect, it } from "vitest";
import { completionMessage, monoSessionCompletionResult, ROLL_UP_SHAPE, SILENT_CHECK } from "./monoSessionCompletion";

const done = (id: string) =>
  monoSessionCompletionResult({
    requestId: id,
    sessionId: id,
    project: "/code/tally",
    prompt: `Fix ${id}`,
    outcome: { status: "completed", text: `Result ${id}` },
  });

describe("lead reports while tracks come back", () => {
  it("a partial report asks for silent checks and one or two lines, not each track's detail", () => {
    const text = completionMessage("r1", [done("median")], { back: 1, total: 6, running: ["Delete", "Health", "Types", "Reset", "Streak"] }).text;
    expect(text).toContain("1 of 6 back");
    expect(text).toContain("without waiting for the rest");
    expect(text).toContain("one or two plain lines");
    expect(text).toContain("Keep each one's detail for the roll-up when all are back");
    expect(text).toContain(SILENT_CHECK);
    expect(text).not.toContain(ROLL_UP_SHAPE);
    expect(SILENT_CHECK).toMatch(/write nothing before or between your checks/);
    expect(SILENT_CHECK).toMatch(/never repeat a line you already wrote/);
  });

  it("the last report rolls everything up once in the Landed / Not fixed shape", () => {
    const text = completionMessage("r2", [done("types"), done("streak")], { back: 6, total: 6, running: [] }).text;
    expect(text).toContain("all 6 of 6 back");
    expect(text).toContain("one consolidated update");
    expect(text).toContain(ROLL_UP_SHAPE);
    expect(ROLL_UP_SHAPE).toContain("Landed / Not fixed");
    expect(ROLL_UP_SHAPE).toContain("each piece of work once");
    // r82 (c02): the shared-type mismatch a worker found was only "checked", never told to Ash.
    expect(ROLL_UP_SHAPE).toMatch(/doesn't match .* is told plainly/);
    expect(text).toContain(SILENT_CHECK);
  });

  it("several sessions back together with no progress still get the roll-up; a single one gets the silent check", () => {
    expect(completionMessage("r3", [done("a"), done("b")]).text).toContain(ROLL_UP_SHAPE);
    const one = completionMessage("r4", [done("a")]).text;
    expect(one).toContain(SILENT_CHECK);
    expect(one).not.toContain(ROLL_UP_SHAPE);
  });
});
