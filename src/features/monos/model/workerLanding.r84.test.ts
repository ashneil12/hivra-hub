import { describe, expect, it } from "vitest";
import { landingDue, landingLine, withLanding } from "./workerLanding";
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
});
