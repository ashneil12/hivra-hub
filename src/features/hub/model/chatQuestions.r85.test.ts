// r85 (s14 r84 run 3): the Lead's "Needs Ash … My pick: gone for good" landed 41s after Ash had answered in the
// worker's chat, and stayed the chat's question until a later turn wrote another one.
import { describe, expect, it } from "vitest";
import { chatQuestion } from "./chatQuestions";

const asked = { role: "assistant" as const, text: "Needs Ash: is a deleted tally gone for good, or kept 30 days?\nMy pick: gone for good." };
const note = { role: "user" as const, internal: true, text: '[MonoCode Ash answered] From the app: Ash answered your worker on "Delete tallies" in its chat: "keep them 30 days".' };

describe("a Needs Ash that Ash already answered in the worker's chat waits on nobody", () => {
  it("is the chat's question without his answer", () => {
    expect(chatQuestion({ busy: false, blocks: [asked] })?.question).toContain("gone for good");
  });
  it("not once his answer reached the chat, even with the Lead's next words after it", () => {
    expect(chatQuestion({ busy: false, blocks: [asked, note] })).toBeNull();
    expect(chatQuestion({ busy: false, blocks: [asked, note, { role: "assistant", text: "Saving that; the job carries on." }] })).toBeNull();
  });
  it("not while his answer waits in the chat's queue", () => {
    expect(chatQuestion({ busy: true, blocks: [asked], queuedMessages: [{ text: note.text }] })).toBeNull();
  });
  it("a new question after his answer still counts", () => {
    const later = { role: "assistant" as const, text: "Needs Ash: should undo show on the board too?" };
    expect(chatQuestion({ busy: false, blocks: [asked, note, later] })?.question).toContain("undo");
  });
});
