// r86 step 4: Ash answering one job's question (in its worker's chat) hid every question the Lead had, queued note or
// delivered. Now only that job's question is settled; another job's stays on Waiting on you.
import { describe, expect, it } from "vitest";
import { answerSettles, chatQuestion } from "./chatQuestions";

const NOTE = '[MonoCode Ash answered] From the app: Ash answered your worker on "Delete tallies" in its chat: "keep them 30 days". The worker carries on.';
const note = { role: "user" as const, internal: true, text: NOTE };
const deleteAsk = { role: "assistant" as const, text: "Needs Ash: When a tally is deleted, is it gone for good, or kept 30 days so it can be brought back? / My pick: Gone for good." };
const exportAsk = { role: "assistant" as const, text: "Needs Ash: Should the CSV export include archived boards? / My pick: No." };

describe("Ash's answer settles only its own job's question", () => {
  it("matches by the job or by his words", () => {
    expect(answerSettles(NOTE, "When a tally is deleted, is it gone for good, or kept 30 days?")).toBe(true);
    expect(answerSettles(NOTE, "Should the CSV export include archived boards?")).toBe(false);
  });

  it("a queued answer hides that job's question, not another job's", () => {
    expect(chatQuestion({ busy: false, queuedMessages: [{ text: NOTE }], blocks: [deleteAsk] })).toBeNull();
    expect(chatQuestion({ busy: false, queuedMessages: [{ text: NOTE }], blocks: [exportAsk] })?.question).toContain("CSV export");
  });

  it("a delivered answer does not wipe another job's earlier question", () => {
    expect(chatQuestion({ busy: false, blocks: [deleteAsk, note, { role: "assistant", text: "The worker will keep them 30 days." }] })).toBeNull();
    expect(
      chatQuestion({ busy: false, blocks: [exportAsk, note, { role: "assistant", text: "The worker will keep them 30 days." }] })?.question,
    ).toContain("CSV export");
  });
});
