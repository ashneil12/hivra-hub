// r91 (c02 run 8382, +207s): the Lead told Ash a job "is still running" 32s after it stopped, because its report was
// still queued behind another. The report the Lead reads now names what else is already back.
import { describe, expect, it } from "vitest";
import { completionMessage, monoSessionCompletionResult } from "./monoSessionCompletion";

const done = (id: string) =>
  monoSessionCompletionResult({ requestId: id, sessionId: id, project: "/code/tally", prompt: `Fix ${id}`, outcome: { status: "completed", text: `Result ${id}` } });

describe("a report names other jobs already back", () => {
  it("says the stopped one is back, never running", () => {
    const text = completionMessage("r1", [done("readme")], { back: 1, total: 1, running: [], backElsewhere: ["Reject negative bump"] }).text;
    expect(text).toContain("Also already stopped, its report reaching you next: Reject negative bump.");
    expect(text).toContain("Don't tell the user it is still running");
  });
  it("says nothing extra when none is", () => {
    expect(completionMessage("r2", [done("readme")], { back: 1, total: 1, running: [] }).text).not.toContain("already stopped");
  });
});
