// r86 (s14 r85 run 1): Ash's answer to a held worker waited behind the Lead's busy turn, and the Lead decided without
// him. His answer is the one app note that cuts into a busy Lead's turn, ahead of the other app deliveries.
import { describe, expect, it } from "vitest";
import { canSteerQueuedHead } from "../../sessions/model/messageQueue";
import { newSession, type QueuedMessage, type Session } from "../../sessions/model/session";
import { ashAnsweredLeadNote } from "./ashAnswersWorker";
import { enqueueMonoSessionCompletion } from "./monoSessionCompletion";

const lead = (queuedMessages: QueuedMessage[]): Session => ({
  ...newSession("claude", "/tmp/project"),
  busy: true,
  turnReady: true,
  queuedMessages,
  queueStatus: "active",
});
const note = ashAnsweredLeadNote({ id: "t-1", title: "Delete tallies" }, "keep them 30 days so i can undo", "a1");
const report: QueuedMessage = { id: "report-1", text: "[MonoCode] a report", attachments: [], monoSessionCompletion: {} as never };
const ash: QueuedMessage = { id: "ash-1", text: "also rename it", attachments: [] };

describe("Ash's answer reaches a busy Lead", () => {
  it("steers into the running turn, unlike other app notes", () => {
    expect(note.steerWhenBusy).toBe(true);
    expect(canSteerQueuedHead(lead([note]))).toBe(true);
    const brief: QueuedMessage = { id: "b", text: "brief", attachments: [], waitForIdle: true, appRequestId: "b" };
    expect(canSteerQueuedHead(lead([brief]))).toBe(false);
  });

  it("goes ahead of reports, behind Ash's own messages", () => {
    const queued = enqueueMonoSessionCompletion(lead([ash, report]), note).queuedMessages!.map((m) => m.id);
    expect(queued).toEqual(["ash-1", note.id, "report-1"]);
    expect(enqueueMonoSessionCompletion(lead([report]), report).queuedMessages).toHaveLength(1);
  });
});

describe("a job Ash already answered is not redone or started twice", () => {
  const row = { id: "t-1", title: "Delete a tally and drop it from the board", state: "running" as const };
  it("turns back a redo or a like job once, quoting his words", async () => {
    const { noteAshAnswer, answeredJobRefusal, forgetAshAnswers } = await import("./ashAnswersWorker");
    forgetAshAnswers();
    noteAshAnswer("t-1", "keep them 30 days so i can undo, then gone for good");
    const again = answeredJobRefusal([row], { requestId: "r2", title: "Delete a tally and drop it from the board" });
    expect(again).toContain('"keep them 30 days so i can undo, then gone for good"');
    expect(again).toContain("Don't start another or redo it");
    expect(answeredJobRefusal([row], { requestId: "r2", title: "Delete a tally" })).toBeUndefined();
    expect(answeredJobRefusal([row], { requestId: "r3", title: "Finish it", redoes: { id: "t-1" } })).toContain("Not started");
    expect(answeredJobRefusal([row], { requestId: "r4", title: "Update the README endpoints table" })).toBeUndefined();
    expect(answeredJobRefusal([{ ...row, state: "completed" }], { requestId: "r5", title: row.title })).toBeUndefined();
  });
});
