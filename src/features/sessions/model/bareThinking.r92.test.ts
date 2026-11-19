// r92 (Critiquito d, s19 blind run d452): bare "Thinking" rows between steps fold away, as a settled Thought does.
import { describe, expect, it } from "vitest";
import { stepsWithoutBareThinking } from "./transcriptActivity";
import type { Block } from "./session";

const tool = (id: string): Block => ({ id, role: "tool", text: `Read ${id}.ts`, tool: { kind: "read", status: "completed" } });
const thought = (id: string, text: string, streaming = false): Block => ({ id, role: "reasoning", text, streaming });

describe("stepsWithoutBareThinking", () => {
  it("drops thoughts between steps while the turn runs (they would only say Thinking)", () => {
    const steps = [tool("a"), thought("t1", "Weighing the rollover."), tool("b"), thought("t2", "", true), tool("c")];
    expect(stepsWithoutBareThinking(steps, true).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });
  it("keeps a settled thought that has words, and drops an empty one", () => {
    const steps = [tool("a"), thought("t1", "Weighing the rollover."), thought("t2", "  "), tool("b")];
    expect(stepsWithoutBareThinking(steps, false).map((b) => b.id)).toEqual(["a", "t1", "b"]);
  });
  it("keeps a list that is only a thought", () => {
    const steps = [thought("t1", "", true)];
    expect(stepsWithoutBareThinking(steps, true)).toEqual(steps);
  });
  it("keeps one Thinking, the latest, when the list is only thoughts (c02 blind 0176 showed three)", () => {
    const steps = [thought("t1", "Checking jobs."), thought("t2", "Reading."), thought("t3", "", true)];
    expect(stepsWithoutBareThinking(steps, true).map((b) => b.id)).toEqual(["t3"]);
  });
});
