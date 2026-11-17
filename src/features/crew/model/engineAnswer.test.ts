import { describe, expect, it } from "vitest";
import { engineTurnOf } from "../../../integrations/harness/providers/t3/t3Outside";
import type { Block } from "../../sessions/model/session";
import { ENGINE_ANSWER_TAG, engineAnswerFor } from "./engineAnswer";

const answer = {
  sessionId: "chat-chief",
  fromSessionId: "chat-mate",
  providerTurnId: "t3x_cnVuOjI",
  text: "Example: notes.txt has 6 lines.\nI counted them twice.",
  finished: true,
};
const mate = { name: "EXO lead", ref: "exo-lead" };

describe("a first mate's answer the chat that asked did not hear", () => {
  it("goes back as an answer from that first mate, to be passed on in the asker's own words", () => {
    const made = engineAnswerFor(answer, { blocks: [] }, mate);
    expect(made?.monoNote).toEqual({ kind: "message", from: "EXO lead", ref: "exo-lead", line: "Example: notes.txt has 6 lines." });
    // The chat draws a request ending in "-reply" as an answer that came back, and it is not a turn to follow.
    expect(made?.appRequestId).toBe("engine-answer-t3x_cnVuOjI-reply");
    expect(engineTurnOf(made?.appRequestId)).toBeUndefined();
    expect(made?.text.startsWith(`${ENGINE_ANSWER_TAG}EXO lead]\n<reply from="EXO lead">\n${answer.text}\n</reply>\n`)).toBe(true);
    expect(made?.text).toContain("It ended after you stopped waiting");
    expect(made?.text).toContain("reply with exactly NO_REPLY");
  });

  it("says so when the job was stopped, or ended with nothing written", () => {
    const body = (extra: Record<string, unknown>) =>
      engineAnswerFor({ ...answer, ...extra }, { blocks: [] }, mate)?.text.split("\n</reply>")[0].split('">\n')[1];
    expect(body({ finished: false })).toBe(`EXO lead was stopped before it finished. The last thing it wrote:\n${answer.text}`);
    expect(body({ finished: false, text: " " })).toBe("EXO lead was stopped before it finished and wrote no answer.");
    expect(body({ text: "" })).toBe("EXO lead finished the job and wrote no answer.");
    expect(engineAnswerFor({ ...answer, text: "" }, { blocks: [] }, mate)?.monoNote.line).toBe("EXO lead finished the job and wrote no answer.");
  });

  it("is nothing when the chat already has it, shown or waiting", () => {
    const shown: Block = { id: "b1", role: "user", text: "x", appRequestId: "engine-answer-t3x_cnVuOjI-reply" };
    expect(engineAnswerFor(answer, { blocks: [shown] }, mate)).toBeNull();
    const waiting = { id: "engine-answer-t3x_cnVuOjI-reply", text: "x" };
    expect(engineAnswerFor(answer, { blocks: [], queuedMessages: [waiting] as never }, mate)).toBeNull();
    expect(engineAnswerFor({ ...answer, providerTurnId: "t3x_other" }, { blocks: [shown] }, mate)).not.toBeNull();
  });
});
