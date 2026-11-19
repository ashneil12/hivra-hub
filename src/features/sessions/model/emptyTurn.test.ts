import { describe, expect, it } from "vitest";
import { appNoteText } from "./appNote";
import { EMPTY_TURN_NOTE, emptyTurnStep, turnSaidNothing } from "./emptyTurn";
import { newSession, type Block, type Session } from "./session";

function chat(blocks: Block[], patch: Partial<Session> = {}): Session {
  return { ...newSession("claude", "/tmp/project"), blocks, ...patch };
}

const ask: Block = { id: "u1", role: "user", text: "What changed?" };
const done = { status: "completed", text: "" };

describe("turnSaidNothing", () => {
  it("is true for a turn with only reasoning or a blank reply", () => {
    expect(turnSaidNothing(chat([ask]))).toBe(true);
    expect(turnSaidNothing(chat([ask, { id: "r", role: "reasoning", text: "hmm" }, { id: "a", role: "assistant", text: "  " }]))).toBe(true);
  });

  it("is false once the turn says or does anything", () => {
    expect(turnSaidNothing(chat([ask, { id: "a", role: "assistant", text: "Two files." }]))).toBe(false);
    expect(turnSaidNothing(chat([ask, { id: "t", role: "tool", text: "", tool: { title: "Read" } }]))).toBe(false);
    expect(turnSaidNothing(chat([ask, { id: "s", role: "system", text: "Provider error" }]))).toBe(false);
    expect(turnSaidNothing(chat([ask, { id: "p", role: "approval", text: "Run?", approval: { requestId: 1 } }]))).toBe(false);
  });

  it("is false while the chat waits on Ash or a limit, or has no turn", () => {
    expect(turnSaidNothing(chat([ask], { usageLimit: {} }))).toBe(false);
    expect(turnSaidNothing(chat([ask], { pendingQuestion: {} as never }))).toBe(false);
    expect(turnSaidNothing(chat([]))).toBe(false);
  });

  it("skips a message still in the queue", () => {
    const queuedBlock: Block = { id: "q1", role: "user", text: "next", draft: true };
    expect(turnSaidNothing(chat([ask, queuedBlock], { queuedMessages: [{ id: "q1", blockId: "q1", text: "next", attachments: [] }] }))).toBe(true);
  });
});

describe("emptyTurnStep (the single retry)", () => {
  it("retries an empty turn once, then shows the second as failed", () => {
    const empty = chat([ask]);
    expect(emptyTurnStep(empty, done, "What changed?", false)).toBe("retry");
    const retried = chat([ask, { id: "u2", role: "user", text: EMPTY_TURN_NOTE }]);
    expect(emptyTurnStep(retried, done, EMPTY_TURN_NOTE, true)).toBe("failed");
  });

  it("settles as usual when the retry answered", () => {
    const answered = chat([ask, { id: "u2", role: "user", text: EMPTY_TURN_NOTE }, { id: "a", role: "assistant", text: "Two files." }]);
    expect(emptyTurnStep(answered, { status: "completed", text: "Two files." }, EMPTY_TURN_NOTE, true)).toBe("settle");
  });

  it("leaves failed or cancelled turns, slash commands and a busy queue alone", () => {
    const empty = chat([ask]);
    expect(emptyTurnStep(empty, { status: "failed" }, "x", false)).toBe("settle");
    expect(emptyTurnStep(empty, { status: "cancelled" }, "x", false)).toBe("settle");
    expect(emptyTurnStep(empty, done, "/compact", false)).toBe("settle");
    expect(emptyTurnStep(empty, done, "/operator do it", false)).toBe("retry");
    expect(emptyTurnStep({ ...empty, queuedMessages: [{ id: "n", text: "n", attachments: [] }] }, done, "x", false)).toBe("settle");
    expect(emptyTurnStep(undefined, done, "x", false)).toBe("settle");
  });

  it("shows the note as an app line, not as Ash's message", () => {
    expect(appNoteText(EMPTY_TURN_NOTE)).toBe("The reply came back empty, so the app asked once more");
  });
});
