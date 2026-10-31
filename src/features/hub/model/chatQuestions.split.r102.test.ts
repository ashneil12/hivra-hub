import { describe, expect, it } from "vitest";
import { chatQuestion, splitDecisions } from "./chatQuestions";

const AD89 =
  "Needs Ash: new-chat shortcut, terminal font size, whether notes sync is the notes panel on the same chat, and whether pin is one chat or several.\nMy pick: Cmd+N, match the chat font, sync the notes panel across windows of the same chat, several pins kept above the list.";

describe("r102 (2): one decision per row, in code", () => {
  it("ad89's four decisions in one ask become four rows, each with its own pick", () => {
    const q = chatQuestion({ busy: false, blocks: [{ id: "a", role: "assistant", text: AD89 }] } as never)!;
    expect(q.rows?.map((r) => r.question)).toEqual([
      "New-chat shortcut?",
      "Terminal font size?",
      "Whether notes sync is the notes panel on the same chat?",
      "Whether pin is one chat or several?",
    ]);
    expect(q.rows?.map((r) => r.pick)).toEqual(["Cmd+N", "match the chat font", "sync the notes panel across windows of the same chat", "Several"]); // the last row is "one chat or several", so its pick is that option
    expect(q.more).toBe(3);
  });
  it("an either-or question stays one decision", () => {
    expect(splitDecisions({ question: "Leave it unsent, or show me a draft first?", redLine: false })).toHaveLength(1);
    expect(splitDecisions({ question: "Which colour, red, green or blue?", redLine: false })).toHaveLength(1);
    expect(splitDecisions({ question: "Which shortcut for a new chat?", pick: "Cmd+N", redLine: false })).toHaveLength(1);
  });
  it("two listed decisions split only when the pick lists two as well", () => {
    expect(splitDecisions({ question: "the refunds FAQ wording, the privacy page owner?", redLine: false })).toHaveLength(1);
    expect(splitDecisions({ question: "the refunds FAQ wording, the privacy page owner?", pick: "short and plain, Chief of Staff", redLine: false })).toHaveLength(2);
  });
});
