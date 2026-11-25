// A job finishing must not close a question Ash never answered (Ash, 13 Nov: "it asked me a question, but then because
// I guess some sort of async result happened ... I didn't answer the question at all ... one heard ask, one done").
// askJobs' pass closes what the build did; a question it was handed to is not the build's to answer, so it goes back to
// waiting on him, with the job's end as the reason on the row.
import { describe, expect, it } from "vitest";
import { withJobs, type JobRow } from "./askJobs";
import { emptyAskDoc, withChange, withHeard, type Ask, type AskDoc } from "./asks";

const T0 = 1_800_000_000_000;
const SEC = 1000;
const REPORT = JSON.stringify({ summary: "Picked take B for the sweep.", filesChanged: [], checks: [], evidence: [], openQuestions: [], selfAssessment: [], missing: [] });

/** A ledger holding one heard ask of the kind named, in one message. */
function ledger(kind: "do" | "answer", quote: string): { doc: AskDoc; id: string } {
  const doc = withHeard(emptyAskDoc(T0), {
    mateId: "mate",
    sessionId: "chat-1",
    blockId: "blk-aaaaaaaaaaaa",
    list: { asks: [{ quote, summary: quote, kind }], maybes: [] },
    by: "model",
    now: T0,
  });
  return { doc, id: doc.asks[0].id };
}

const job = (id: string, askIds: string[], patch: Partial<JobRow> = {}): JobRow => ({ id, askIds, status: "working", title: "Sweep the notes", ...patch });
const passed = (id: string, askIds: string[], at: number): JobRow =>
  job(id, askIds, { status: "done", gateVerdict: "passed", report: REPORT, settledAt: at, updatedAt: at });
const get = (doc: AskDoc, id: string): Ask => doc.asks.find((ask) => ask.id === id) as Ask;

const QUESTION = "which of the two takes should I ship";

describe("a job that passed with a question on it", () => {
  it("leaves the question open, waiting on him, and says the job finished without answering it", () => {
    const { doc, id } = ledger("answer", QUESTION);
    const out = withJobs(doc, [passed("t-1", [id], T0 + SEC)], T0 + 2 * SEC);
    expect(get(out, id)).toMatchObject({ status: "waiting" });
    expect(get(out, id).note).toMatch(/finished/i);
    expect(get(out, id).note).toMatch(/answer/i);
    expect(get(out, id).proof).toBeUndefined();
  });

  it("applies once: a later pass over the same rows changes nothing", () => {
    const { doc, id } = ledger("answer", QUESTION);
    const rows = [passed("t-1", [id], T0 + SEC)];
    const once = withJobs(doc, rows, T0 + 2 * SEC);
    const twice = withJobs(once, rows, T0 + 5 * SEC);
    expect(twice).toBe(once);
  });

  it("still closes a job's own work as done, and never reopens a question he answered", () => {
    const work = ledger("do", "please fix the save bug on the settings page");
    const closed = withJobs(work.doc, [passed("t-2", [work.id], T0 + SEC)], T0 + 2 * SEC);
    expect(get(closed, work.id)).toMatchObject({ status: "done" });

    const asked = ledger("answer", QUESTION);
    const answered = withChange(asked.doc, asked.id, { status: "done", proof: "take B" }, "ash", T0 + SEC);
    if ("problem" in answered) throw new Error(answered.problem);
    const after = withJobs(answered.doc, [passed("t-3", [asked.id], T0 + 2 * SEC)], T0 + 3 * SEC);
    expect(get(after, asked.id)).toMatchObject({ status: "done", proof: "take B" });
  });
});
