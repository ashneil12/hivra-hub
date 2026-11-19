// r67 (Critiquito on r66): "Your report came back without a self-review" rendered as if Ash typed it. The re-ask goes
// as a hidden app turn with a quiet system line (a MonoNote, like Self-repair's), never as a turn that reads as his.
import { expect, it } from "vitest";
import { reviewAsk, reviewAskNote } from "./workerReview";

it("the re-ask carries a system note from MonoCode, in plain words", () => {
  expect(reviewAskNote()).toEqual({ kind: "message", from: "MonoCode", line: "Asked for the self-review the report came back without" });
  expect(reviewAsk("The Checked: line is empty.")).toMatch(/^Your report came back without a self-review/);
});
