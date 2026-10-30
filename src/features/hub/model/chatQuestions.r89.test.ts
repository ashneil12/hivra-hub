// r89 step 1 (Ash, s14 r88 run 2): after the delete job landed, the Lead blocked on a second question about it and
// recommended 404 against the reason the work gave. A blocking question about a landed job is held for review now, and
// Ash's answer in a worker's chat drops the Lead's queued wake with that worker's question.
import { describe, expect, it } from "vitest";
import { answeredQuestionWakes } from "../../monos/model/ashAnswersWorker";
import { questionWakeId } from "../../monos/model/delegationQuestions";
import { chatQuestion, gateQuestion, landedJobAsked } from "./chatQuestions";

const landed = {
  role: "user" as const,
  internal: true,
  text: "Worker report. [MonoCode landed] The app put this worker's changes into the project (not committed): README.md.",
  monoSessionCompletion: { sessionId: "w1", title: "Delete a tally and drop it from the board", status: "completed" as const },
};
const after = {
  role: "assistant" as const,
  text: "Needs the user: for a deleted tally still inside the 30 days, should stats keep returning the old entries, or be a 404 like a bump?\nMy pick: 404. Undo still has the saved entries.",
};
const other = { role: "assistant" as const, text: "Needs Ash: Should the CSV export include archived boards?\nMy pick: No." };

describe("a blocking question about a landed job is held for review", () => {
  it("finds the landed job the question names", () => {
    expect(landedJobAsked([landed], "for a deleted tally still inside the 30 days, should stats keep returning the old entries, or be a 404?")).toBe(
      "Delete a tally and drop it from the board",
    );
    expect(landedJobAsked([landed], "Should the CSV export include archived boards?")).toBeUndefined();
  });

  it("the gate holds it, with the reason", () => {
    const q = chatQuestion({ busy: false, blocks: [landed, after] })!;
    expect(q.afterLanding).toBe("Delete a tally and drop it from the board");
    const gate = gateQuestion(q);
    expect(gate.admit).toBe(false);
    expect(gate.reason).toMatch(/already landed, so it is held for review/);
  });

  it("another job's question still blocks", () => {
    expect(gateQuestion(chatQuestion({ busy: false, blocks: [landed, other] })!).admit).toBe(true);
  });

  it("a question before any landing still blocks", () => {
    expect(gateQuestion(chatQuestion({ busy: false, blocks: [after] })!).admit).toBe(true);
  });

  it("a report that did not land holds nothing", () => {
    const notLanded = { ...landed, text: "Worker report. [MonoCode not landed] tests failed." };
    expect(gateQuestion(chatQuestion({ busy: false, blocks: [notLanded, after] })!).admit).toBe(true);
  });
});

describe("Ash's answer in a worker's chat drops the Lead's queued question wake", () => {
  it("returns only that worker's question wakes", () => {
    const lead = {
      queuedMessages: [
        { id: questionWakeId("w1", 3) },
        { id: questionWakeId("w2", 1) },
        { id: "ash-answered-t1-x" },
      ],
    };
    expect(answeredQuestionWakes(lead, "w1")).toEqual([questionWakeId("w1", 3)]);
    expect(answeredQuestionWakes(undefined, "w1")).toEqual([]);
  });
});
