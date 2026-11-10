import { describe, expect, it } from "vitest";
import { readSetting } from "./setting";
import { readingEntries, reviewerChoice, runReview, type ReviewerPort } from "./review";

const PLAN = "Save the note when the person taps Save. Done when the note is still there after a reload.";

function port(answers: Record<string, string | Error>): ReviewerPort & { calls: { history: readonly []; model: string | null; prompt: string }[] } {
  const calls: { history: readonly []; model: string | null; prompt: string }[] = [];
  return {
    calls,
    ask: async (turn) => {
      calls.push({ history: turn.history, model: turn.model, prompt: turn.prompt });
      const answer = answers[turn.persona];
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    },
  };
}

describe("fresh-eyes setting", () => {
  it("is off unless the stored value is a real true", () => {
    expect(readSetting(undefined).enabled).toBe(false);
    expect(readSetting({ enabled: "true", autoAcceptClean: 1, reviewerCount: 9, model: "opus\n" }).enabled).toBe(false);
    expect(readSetting({ enabled: "true" }).autoAcceptClean).toBe(false);
    expect(readSetting({ enabled: "true" }).reviewerCount).toBe(2);
    expect(readSetting({ enabled: "true" }).model).toBe(null);
    expect(readSetting({ enabled: true, autoAcceptClean: true, reviewerCount: 3, model: "claude:haiku-4.5" })).toMatchObject({
      enabled: true,
      autoAcceptClean: true,
      reviewerCount: 3,
      model: "claude:haiku-4.5",
    });
  });
});

describe("fresh-eyes reviewers", () => {
  it("sends an empty history and the cheap model, not the lead model", async () => {
    const reviewers = port({
      "design-critic": "",
      readiness: "",
    });
    const run = await runReview({
      plan: PLAN,
      reading: [{ path: "docs/notes.md", text: "Notes reload from disk." }],
      count: 2,
      choice: reviewerChoice({ cli: "claude", model: "claude-opus-5-5", effort: "high" }, null),
      port: reviewers,
    });
    expect(run.status).toBe("cleared");
    expect(reviewers.calls).toHaveLength(2);
    for (const call of reviewers.calls) {
      expect(call.history).toEqual([]);
      expect(call.model).toBe("claude-haiku-4-5");
      expect(call.prompt).toContain(PLAN);
      expect(call.prompt).toContain("docs/notes.md");
      expect(call.prompt).not.toContain("claude-opus-5-5");
      expect(call.prompt).not.toContain("yesterday we decided");
    }
    expect(reviewerChoice({ cli: "claude", model: "claude-opus-5-5", effort: "high" }, null).effort).toBe("low");
    expect(reviewerChoice({ cli: "claude", model: "claude-opus-5-5" }, "claude-opus-5-5").model).toBe("claude-opus-5-5");
  });

  it("does not call a reviewer for an empty plan", async () => {
    const reviewers = port({});
    const run = await runReview({
      plan: "  \r\n  ",
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    expect(run.status).toBe("empty");
    expect(run.calls).toEqual([]);
    expect(reviewers.calls).toEqual([]);
  });

  it("keeps the other reviewer's findings when one reviewer fails", async () => {
    const reviewers = port({
      "design-critic": new Error("the seat broke"),
      readiness: "FINDING: The reload step is missing.\nBREAK: A saved note can vanish.",
    });
    const run = await runReview({
      plan: PLAN,
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    expect(run.failed).toEqual(["design-critic"]);
    expect(run.findings).toEqual([
      { persona: "readiness", summary: "The reload step is missing.", break: "A saved note can vanish." },
    ]);
    expect(run.status).toBe("findings");
  });

  it("merges the same finding from two reviewers into one", async () => {
    const shared = "FINDING: Done is not defined.\nBREAK: Nobody can tell when to stop.";
    const reviewers = port({ "design-critic": shared, readiness: shared });
    const run = await runReview({
      plan: PLAN,
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]?.summary).toBe("Done is not defined.");
  });

  it("treats a reply that is not a finding as a failed reviewer, not a pass", async () => {
    const reviewers = port({
      "design-critic": "This plan looks fine to me, honestly.",
      readiness: "",
    });
    const run = await runReview({
      plan: PLAN,
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    expect(run.failed).toEqual(["design-critic"]);
    expect(run.status).toBe("pending");
    expect(run.findings).toEqual([]);
  });

  it("treats a timeout as something to ask again, not as a pass", async () => {
    const reviewers = port({
      "design-critic": new Error("The reviewer timed out"),
      readiness: "",
    });
    const run = await runReview({
      plan: PLAN,
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    expect(run.retry).toBe(true);
    expect(run.status).toBe("pending");
    expect(run.findings).toEqual([]);
  });

  it("drops a reading path that climbs out, and a duplicate", () => {
    expect(
      readingEntries([
        { path: "../secret", text: "no" },
        { path: "docs\\plan.md", text: "yes\r\nline" },
        { path: "docs/plan.md", text: "again" },
        { path: "docs/empty.md", text: "  " },
        { path: "docs/ok.md", text: "kept" },
      ]),
    ).toEqual([
      { path: "docs/plan.md", text: "yes\nline" },
      { path: "docs/ok.md", text: "kept" },
    ]);
  });
});
