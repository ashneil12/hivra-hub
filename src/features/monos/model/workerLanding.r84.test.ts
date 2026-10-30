import { describe, expect, it } from "vitest";
import { landingDue, landingLine, refreshAsk, stopQuestion, withLanding, withStopHeld } from "./workerLanding";
import type { MonoSessionCompletionResult } from "./monoSessionCompletion";

const done = (over: Partial<MonoSessionCompletionResult> = {}): MonoSessionCompletionResult =>
  ({ sessionId: "w", project: "tally", title: "Reject negative bump", status: "completed", originalPrompt: "", result: "A negative bump is rejected.", truncated: false, ...over }) as MonoSessionCompletionResult;
const copy = { cwd: "/p/tally", worktreeCwd: "/p/tally-worktrees/mc-1" };

describe("a finished worker's changes land in the project (r84)", () => {
  it("lands a finished worker in its own copy", () => {
    expect(landingDue(done(), copy)).toEqual({ checkout: "/p/tally-worktrees/mc-1", project: "/p/tally" });
  });

  it("never lands work that stopped on Ash's choice, failed, or has no copy of its own", () => {
    expect(landingDue(done({ result: "Stopped. Needs Ash: keep deleted tallies 30 days or delete for good?\nMy pick: 30 days" }), copy)).toBeUndefined();
    expect(landingDue(done({ status: "failed" }), copy)).toBeUndefined();
    expect(landingDue(done(), { cwd: "/p/tally" })).toBeUndefined();
  });

  it("tells the Lead first what happened", () => {
    const r = withLanding(done(), { outcome: "landed", files: ["packages/shared/src/validate.ts", "packages/api/test/server.test.ts"], why: "" });
    expect(r.result.split("\n")[0]).toBe("[MonoCode landed] The app put this worker's changes into the project (not committed): packages/shared/src/validate.ts, packages/api/test/server.test.ts.");
    expect(landingLine({ outcome: "conflict", files: ["a.ts"], why: "patch failed: a.ts:3" })).toMatch(/^\[MonoCode not landed\].*a\.ts.*patch failed/);
    expect(withLanding(done(), null).result).toBe("A negative bump is rejected.");
  });

  it("work that didn't land is not done, and its worker is asked once to settle the clash", () => {
    const clash = { outcome: "conflict" as const, files: ["packages/ui/src/App.tsx", "packages/ui/src/format.ts"], why: "patch failed" };
    const r = withLanding(done(), clash);
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("failed: its changes clash with the project");
    expect(refreshAsk(clash, ["packages/ui/src/App.tsx"])).toContain("packages/ui/src/App.tsx now carry conflict markers");
    expect(refreshAsk(clash, [])).toContain("They merged cleanly.");
  });
});

describe("a stop on Ash's choice holds the job as a question (r84 s14 blind)", () => {
  const stop = done({ result: "Stopped. Delete is half wired.\nNeeds Ash: when a tally is deleted, is it gone for good, or kept 30 days?\nMy pick: gone for good." });
  it("the row's question is the Needs Ash line", () => {
    expect(stopQuestion(stop)).toBe("Needs Ash: when a tally is deleted, is it gone for good, or kept 30 days?");
  });
  it("the Lead reads that it is held and how to carry it on", () => {
    const held = withStopHeld(stop, "d-7").result;
    expect(held).toMatch(/^\[MonoCode held\]/);
    expect(held).toContain('redoes "d-7"');
    expect(held).toContain("Needs Ash: when a tally");
  });
});

it("s14 blind 2's stop without the word Stopped still holds", () => {
  const text = "DELETE currently removes the tally for good. That choice is his, so I did not switch it.\nNeed a decision from Ash before this ships: gone for good, or kept 30 days?";
  expect(landingDue(done({ result: text }), copy)).toBeUndefined();
  expect(stopQuestion(done({ result: text }))).toBe("Need a decision from Ash before this ships: gone for good, or kept 30 days?");
});
