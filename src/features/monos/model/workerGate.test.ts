// r82: the routes check runs in the app when a delegated worker reports done (gates.rs), not only on the bench.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MonoSessionCompletionResult } from "./monoSessionCompletion";
import { gateAsk, gateDue, gateFailedResult, gateVerdict, GATE_TRIES, signedOffSince, workerGateWord, type GateRun, type GateRunner } from "./workerGate";

const done = (over: Partial<MonoSessionCompletionResult> = {}): MonoSessionCompletionResult =>
  ({
    sessionId: "w1",
    project: "/code/tally-worktrees/mc-1",
    title: "Add tally delete",
    status: "completed",
    originalPrompt: "Add delete",
    result: "Added DELETE /tallies/:id.",
    truncated: false,
    reviewRequired: true,
    review: { checked: "delete", how: "npm test", unsure: "nothing" },
    ...over,
  }) as MonoSessionCompletionResult;

const failed: GateRun = { name: "Routes check", ok: false, output: "DELETE /tallies/:id answers 204 but Ash hasn't signed it off." };
const passed: GateRun = { name: "Routes check", ok: true, output: "" };

describe("when the check runs", () => {
  it("on a delegated worker's finished report with its self-review", () => {
    expect(gateDue(done())).toBe(true);
  });
  it("not on a failed one, one still owed its self-review, a chat that isn't a delegated worker, or one stopped on Ash", () => {
    expect(gateDue(done({ status: "failed" }))).toBe(false);
    expect(gateDue(done({ reviewProblem: "no section" }))).toBe(false);
    expect(gateDue(done({ reviewRequired: undefined }))).toBe(false);
    expect(gateDue(done({ review: { checked: "delete", how: "npm test", unsure: "Paused until Ash decides: gone for good or 30 days" } }))).toBe(false);
  });
});

describe("what happens after it ran", () => {
  it("passes or has no check: the report goes to the Lead", () => {
    expect(gateVerdict(passed, 0)).toBe("deliver");
    expect(gateVerdict(null, 0)).toBe("deliver");
  });
  it("fails: back to the worker once, then to the Lead as failed after two tries", () => {
    expect(GATE_TRIES).toBe(2);
    expect(gateVerdict(failed, 1)).toBe("resend");
    expect(gateVerdict(failed, 2)).toBe("deliver-failed");
  });
  it("the worker gets the check's words as a MonoCode note; the Lead's failure carries them", () => {
    const ask = gateAsk(failed);
    expect(ask).toMatch(/^\[MonoCode check\] Routes check failed on your copy/);
    expect(ask).toContain(failed.output);
    expect(ask).toMatch(/stop and ask your Lead/);
    const lead = gateFailedResult(done(), failed);
    expect(lead.status).toBe("failed");
    expect(lead.error).toBe(`Routes check still failed after 2 tries: ${failed.output}`);
  });
});

describe("Ash signs off by answering", () => {
  const log = [
    { at: 1, sessionId: "lead", title: "Tally lead", question: "Gone or 30 days?", admit: true, reason: "", answer: { words: "30 days", by: "words" as const, at: 500 } },
  ];
  it("an answer in the Lead's chat since the worker started", () => {
    expect(signedOffSince("lead", 400, log as never)).toBe(true);
    expect(signedOffSince("lead", 600, log as never)).toBe(false);
    expect(signedOffSince("other", 400, log as never)).toBe(false);
  });
});

describe("the seam: a fake runner through the two tries", () => {
  it("fail, fail: the worker hears it once, the Lead gets the failure", async () => {
    const runs: GateRun[] = [failed, failed];
    const runner: GateRunner = async () => runs.shift() ?? passed;
    const sent: string[] = [];
    let failures = 0;
    let delivered: MonoSessionCompletionResult | undefined;
    for (let turn = 0; turn < 3 && !delivered; turn++) {
      const result = done();
      const run = await runner({ projectId: "tally", checkout: "/code/tally-worktrees/mc-1", signedOff: false });
      if (run && !run.ok) failures += 1;
      const verdict = gateVerdict(run, failures);
      if (verdict === "resend") sent.push(gateAsk(run!));
      else delivered = verdict === "deliver-failed" ? gateFailedResult(result, run!) : result;
    }
    expect(sent).toHaveLength(1);
    expect(delivered?.status).toBe("failed");
  });

  it("fail, then pass: the fixed report goes to the Lead as done", async () => {
    const runs: GateRun[] = [failed, passed];
    const runner: GateRunner = async () => runs.shift() ?? passed;
    let failures = 0;
    const verdicts: string[] = [];
    for (let turn = 0; turn < 2; turn++) {
      const run = await runner({ projectId: "tally", checkout: "/x", signedOff: true });
      if (run && !run.ok) failures += 1;
      verdicts.push(gateVerdict(run, failures));
    }
    expect(verdicts).toEqual(["resend", "deliver"]);
  });
});

describe("WP-91: the check's word for a task", () => {
  const input = { projectId: "tally", checkout: "/x", signedOff: false };
  it("is WP-40's word: passed, failed, or no check at all", async () => {
    expect(await workerGateWord(async () => passed, input)).toBe("passed");
    expect(await workerGateWord(async () => failed, input)).toBe("failed");
    // A project with no check configured: nothing ran, and the task records no word rather than a pass.
    expect(await workerGateWord(async () => null, input)).toBeNull();
  });
  it("reads a check that could not run as notRun, never as no check", async () => {
    const thrown: GateRunner = async () => {
      throw new Error("The worker's checkout isn't there.");
    };
    expect(await workerGateWord(thrown, input)).toBe("notRun");
  });
  it("is asked on a task's own copy by the orchestrator, and the app passes the project and that checkout", () => {
    const app = fs.readFileSync(path.resolve(__dirname, "../../../app/App.tsx"), "utf8");
    expect(app).toMatch(/gateWorker: async \(run, task\) => \{\n\s*const checkout = task\.workspace\?\.checkoutCwd \?\? orchestrationCheckoutCwd\(run\);/);
    expect(app).toMatch(/workerGateWord\(runTaskGate, \{/);
    const orchestrator = fs.readFileSync(
      path.resolve(__dirname, "../../orchestration/model/orchestration.ts"),
      "utf8",
    );
    // Once its turn is in, before anything can be accepted; the failed-turn case never asks.
    expect(orchestrator).toMatch(/if \(this\.host\?\.gateWorker && outcome\.status === "completed"\) \{/);
  });
});

it("App runs the check before a finished worker's report goes out, and sends its words to that worker", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../../../app/App.tsx"), "utf8");
  expect(app).toMatch(/if \(gateDue\(result\)\) \{/);
  expect(app).toMatch(/runWorkerGate\(\{ projectId, checkout, signedOff: signedOffFor\(workerStarted, monoId, /);
  expect(app).toMatch(/submitSessionRef\.current\(sessionId, gateAsk\(run\), \[\], \{/);
  expect(app).toMatch(/finish\(gateFailedResult\(result, run\)\)/);
});

describe("the copy the check runs on (s14 r82 #2)", () => {
  it("is an isolated worker's worktree, not the project it started in", async () => {
    const { gateCheckout } = await import("./workerGate");
    expect(gateCheckout({ cwd: "/p/tally", worktreeCwd: "/p/tally-worktrees/mc-1" })).toBe("/p/tally-worktrees/mc-1");
    expect(gateCheckout({ cwd: "/p/tally-worktrees/mc-2" })).toBe("/p/tally-worktrees/mc-2");
    expect(gateCheckout(undefined)).toBeUndefined();
  });
});

