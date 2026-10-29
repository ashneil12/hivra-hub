import { describe, expect, it } from "vitest";
import { foldStopped, stoppedLine } from "./stuckFold";

type K = "asking" | "failed" | "stalled";
const s = (kind: K, id: string, row: Record<string, unknown> = {}) =>
  ({ kind, id, row: { id, state: kind === "failed" ? "failed" : "running", error: "Stopped with an error.", log: [], ...row } }) as never;
const ids = (cards: readonly unknown[]) => (cards as { id: string }[]).map((c) => c.id);

describe("r70 (a): stopped workers fold into one line above a Lead's composer", () => {
  it("folds failed and stalled workers, keeps asking cards", () => {
    const { cards, stopped } = foldStopped([s("failed", "a"), s("asking", "b"), s("stalled", "c")], false);
    expect(stopped).toBe(2);
    expect(ids(cards)).toEqual(["b"]);
  });

  it("Show opens every card", () => {
    const { cards, stopped } = foldStopped([s("failed", "a"), s("stalled", "c")], true);
    expect(stopped).toBe(2);
    expect(cards).toHaveLength(2);
  });

  it("a red one only Ash can sort (out of credits) stays a card, never folded", () => {
    const red = s("failed", "r", { errorClass: "billing", error: "Your credit balance is too low" });
    const { cards, stopped } = foldStopped([red, s("failed", "a")], false);
    expect(stopped).toBe(1);
    expect(ids(cards)).toEqual(["r"]);
  });

  it("no stopped workers: no fold line", () => {
    expect(foldStopped([s("asking", "b")], false).stopped).toBe(0);
  });

  it("says it in words", () => {
    expect(stoppedLine(1)).toBe("1 worker stopped");
    expect(stoppedLine(3)).toBe("3 workers stopped");
  });
});
