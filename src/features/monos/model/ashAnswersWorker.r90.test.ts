import { describe, expect, it } from "vitest";
import { ashAnsweredLeadNote } from "./ashAnswersWorker";

// r90 (s14 run 3): the note was steered into the Lead's busy turn, but that turn's wake said to start with
// "Needs Ash:", so the Lead still asked. The note now overrides the wake for that choice.
describe("ashAnsweredLeadNote overrides a busy turn's ask", () => {
  it("tells the Lead not to write a Needs Ash line for the answered choice", () => {
    const note = ashAnsweredLeadNote({ id: "row-1", title: "Delete a tally" }, "keep them 30 days", "a1");
    expect(note.steerWhenBusy).toBe(true);
    expect(note.text).toMatch(/even if this turn was told to ask .*: write no `Needs Ash:` line and no pick for it/);
    expect(note.text).toMatch(/start your reply with `Answered:`/);
  });
});
