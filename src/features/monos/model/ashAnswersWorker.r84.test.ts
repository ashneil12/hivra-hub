// r84 (s14 r83): Ash answered the worker in its chat; the Lead never saved or spoke, the job read completed, and the
// worker's update was a wall of test output.
import { describe, expect, it } from "vitest";
import { ASH_ANSWERED_PREFIX, ashAnsweredLeadNote, ashWordsNote, openJobOf } from "./ashAnswersWorker";
import { cutTestOutput } from "./testOutput";
import { stoppedForAsh } from "./workerLanding";
import type { Delegation } from "./delegations";
import type { MonoSessionCompletionResult } from "./monoSessionCompletion";

const row = (over: Partial<Delegation>): Delegation =>
  ({ id: "t1", ownerSession: "lead", childSession: "w1", title: "Delete a tally and drop it from the board", state: "running", createdAt: 1, ...over }) as Delegation;
const report = (result: string): MonoSessionCompletionResult =>
  ({ sessionId: "w1", project: "tally", title: "Delete", status: "completed", originalPrompt: "", result, truncated: false }) as MonoSessionCompletionResult;

describe("a worker that stops on Ash's choice keeps its job open", () => {
  it("knows the r83 stop report for what it is, and a finished one for done", () => {
    expect(stoppedForAsh(report("Stopped. The hard delete is reverted and the working tree is clean again. Nothing is shipping until you decide.  Ash has not signed off deleting a tally."))).toBe(true);
    expect(stoppedForAsh(report("Delete keeps a tally 30 days, then it is gone for good. npm test: 18 passed."))).toBe(false);
  });
  it("finds the worker chat's open job, never a finished or older one", () => {
    expect(openJobOf([row({})], "w1")?.id).toBe("t1");
    expect(openJobOf([row({ state: "completed" })], "w1")).toBeUndefined();
    expect(openJobOf([row({ state: "running", createdAt: 1 }), row({ id: "t2", state: "completed", createdAt: 2 })], "w1")).toBeUndefined();
    expect(openJobOf([row({})], "w2")).toBeUndefined();
  });
});

describe("Ash's answer in the worker's chat reaches the Lead at once", () => {
  it("his words, save with ash_remember, one line on what's next", () => {
    const note = ashAnsweredLeadNote(row({}), "keep them 30 days so i can undo, then gone for good", "k1");
    expect(note.id).toBe("ash-answered-t1-k1");
    expect(note.waitForIdle).toBe(true);
    expect(note.text.startsWith(ASH_ANSWERED_PREFIX)).toBe(true);
    expect(note.text).toContain('"keep them 30 days so i can undo, then gone for good"');
    expect(note.text).toContain("ash_remember");
    expect(note.text).toContain("not from any pick of yours");
  });
  it("the worker is told his words outrank its Lead", () => {
    expect(ashWordsNote()).toContain("outrank your brief and any pick from your Lead");
  });
});

describe("worker updates reach the Lead summarised", () => {
  it("cuts a run of test output to its last line", () => {
    const text = ["Done: delete keeps tallies 30 days.", "✓ add (2ms)", "✓ bump (1ms)", "✓ delete (3ms)", "✓ restore (1ms)", "✓ purge (1ms)", "Tests  5 passed (5)", "Unsure: nothing"].join("\n");
    expect(cutTestOutput(text)).toBe(["Done: delete keeps tallies 30 days.", "[5 lines of test output cut]", "Tests  5 passed (5)", "Unsure: nothing"].join("\n"));
    expect(cutTestOutput("npm test: 5 passed\n✓ one")).toBe("npm test: 5 passed\n✓ one");
  });
});
