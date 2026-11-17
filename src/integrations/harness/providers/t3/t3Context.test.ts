import { describe, expect, it } from "vitest";
import { monoTurn } from "../../../../features/monos/model/monoFiles";
import { t3Message } from "./t3Context";

describe("a turn's text as T3 takes it", () => {
  it("moves what the app put ahead of the message into a context record, and leaves the person's words with a link to it", () => {
    const sent = monoTurn("Example: count the lines.\n\nThen the words.", ["Example: you are the first mate.", "Example: memory"]);
    const { text, context } = t3Message(sent);
    expect(text).toBe("[Dropwave context](t3-context://v1/dropwave-context/dropwave_context)\n\nExample: count the lines.\n\nThen the words.");
    expect(context).toEqual({
      version: 1,
      records: [
        {
          version: 1,
          contextId: "dropwave_context",
          kind: "dropwave-context",
          label: "Dropwave context",
          payload: sent.slice(0, sent.indexOf("</monocode_context>") + "</monocode_context>".length),
        },
      ],
    });
    expect(context?.records[0].payload).toContain("Example: you are the first mate.");
    expect(text).not.toContain("monocode_context");
  });

  it("sends a turn as it is when the app added nothing, the block is not closed, or it is more than one record holds", () => {
    expect(t3Message("Example: hello")).toEqual({ text: "Example: hello" });
    expect(t3Message("<monocode_context>\nExample: cut")).toEqual({ text: "<monocode_context>\nExample: cut" });
    const long = monoTurn("Example: hello", ["x".repeat(70_000)]);
    expect(t3Message(long)).toEqual({ text: long });
    // A message that only quotes the tag further down is the person's own text.
    const quoted = "Example: what is <monocode_context>\nthis\n</monocode_context>?";
    expect(t3Message(quoted)).toEqual({ text: quoted });
  });
});
