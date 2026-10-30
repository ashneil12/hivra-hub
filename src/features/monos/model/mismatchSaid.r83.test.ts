// r83 (c02 r82): a worker's mismatch or TODO deviation reaches the Lead as a line it must pass on.
import { describe, expect, it } from "vitest";
import { completionMessage, mismatchSaid } from "./monoSessionCompletion";

describe("the app lifts a worker's mismatch for the Lead", () => {
  it("finds the worker's own sentence, and nothing in a plain report", () => {
    expect(mismatchSaid("Done. The local board type and the shared type do not match. I switched it.")).toBe(
      "The local board type and the shared type do not match.",
    );
    expect(mismatchSaid("Added GET /health. TODO.md says { \"status\": \"alive\" }; I return { ok: true, version }.")).toMatch(/^TODO\.md says/);
    expect(mismatchSaid("Added the README line. npm test: 11 pass.\n## Self-review\nUnsure: does it match the style")).toBeUndefined();
  });
  it("puts it in the completion notification", () => {
    const message = completionMessage("n1", [
      {
        sessionId: "s1",
        title: "Board",
        status: "completed",
        result: "The local board type and the shared type do not match.",
        originalPrompt: "use the shared type",
        project: "/p",
      } as never,
    ]);
    expect(message.text).toContain('TELL ASH plainly');
    expect(message.text).toContain('Board: "The local board type and the shared type do not match."');
  });
});
