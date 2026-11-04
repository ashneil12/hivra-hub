// Hivra WP-40: a finished report is done only when the gates passed. One failure goes back to the worker; the next
// fails. Unsure, or a check that couldn't run, is not a pass and is not another fix round.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { completionMessage, type MonoSessionCompletionResult } from "../../monos/model/monoSessionCompletion";
import { GATE_TRIES } from "../../monos/model/workerGate";
import { briefGateAction, briefGatesFor, gateRequest, type GateRecordView } from "./completionGates";

const done = (over: Partial<MonoSessionCompletionResult> = {}): MonoSessionCompletionResult =>
  ({
    sessionId: "w1",
    project: "/code/tally",
    title: "Add tally delete",
    status: "completed",
    originalPrompt: "Add delete",
    result: "Added DELETE /tallies/:id.",
    truncated: false,
    ...over,
  }) as MonoSessionCompletionResult;

const failed: GateRecordView = { verdict: "failed", summary: "Change made failed: nothing changed." };
const passed: GateRecordView = { verdict: "passed", summary: "Change made, Project checks passed." };
const unsure: GateRecordView = { verdict: "unsure", summary: "The quick check couldn't tell whether the brief was met." };

describe("what a brief asks for", () => {
  it("is nothing when no gates, checks or code were named", () => {
    expect(gateRequest({})).toBeUndefined();
    expect(gateRequest({ gates: [], checks: [], code: false })).toBeUndefined();
    expect(gateRequest({ checks: ["", "  "] })).toBeUndefined();
  });

  it("keeps a code brief, named gates and named checks, and drops duplicates and blank checks", () => {
    expect(gateRequest({ code: true })).toEqual({ code: true });
    expect(gateRequest({ gates: [" diff\r", "diff", "routes"] })).toEqual({ gates: ["diff", "routes"] });
    expect(gateRequest({ gates: ["routes"] })).toEqual({ gates: ["routes"] });
    expect(gateRequest({ checks: ["lint", " lint ", "", "lint"] })).toEqual({ checks: ["lint"] });
  });

  it("refuses a word that isn't a gate, a checks list that doesn't fit, and a code flag that isn't true or false", () => {
    expect(() => gateRequest({ gates: ["made-up"] })).toThrow(
      `"made-up" isn't a gate. Use diff, checks, committed, ratchet or routes.`,
    );
    expect(() => gateRequest({ gates: [1] })).toThrow("gates must be a list of names");
    expect(() => gateRequest({ gates: "diff" })).toThrow("gates must be a list of names");
    expect(() => gateRequest({ checks: "lint" })).toThrow("checks must be a list of names");
    expect(() => gateRequest({ checks: Array.from({ length: 21 }, (_, i) => `c${i}`) })).toThrow(
      "Name at most 20 checks, by their ids in the project's file.",
    );
    expect(() => gateRequest({ checks: ["x".repeat(61)] })).toThrow("Name at most 20 checks");
    expect(gateRequest({ checks: Array.from({ length: 20 }, (_, i) => `c${i}`) })?.checks).toHaveLength(20);
    expect(gateRequest({ checks: ["x".repeat(60)] })?.checks?.[0]).toHaveLength(60);
    expect(() => gateRequest({ code: "true" })).toThrow("code must be true or false");
  });
});

describe("one round", () => {
  it("a pass lands, and it is not sent back", () => {
    expect(briefGateAction(passed, 0)).toEqual({ action: "pass" });
    expect(briefGateAction(passed, GATE_TRIES)).toEqual({ action: "pass" });
  });

  it("a failure goes back once, in the check's words, then the report is failed", () => {
    const first = briefGateAction(failed, 0);
    expect(first.action).toBe("resend");
    if (first.action !== "resend") return;
    expect(first.ask).toMatch(/^\[MonoCode check\] The checks failed on your copy/);
    expect(first.ask).toContain(failed.summary);
    expect(first.note).toEqual({
      kind: "message",
      from: "MonoCode",
      line: "Checks failed; their words went back to the worker",
    });
    expect(first.failed(done()).status).toBe("failed");

    const second = briefGateAction(failed, 1);
    expect(second.action).toBe("fail");
    if (second.action !== "fail") return;
    const lead = second.apply(done());
    expect(lead.status).toBe("failed");
    expect(lead.error).toContain(failed.summary);
    expect(lead.error).toMatch(/after 2 tries/);
  });

  it("unsure is not a pass, not a fix round, and stays completed for its first mate", () => {
    for (const failures of [0, 1, 4]) {
      const step = briefGateAction(unsure, failures);
      expect(step.action, String(failures)).toBe("unsure");
      if (step.action !== "unsure") continue;
      const lead = step.apply(done());
      expect(lead.status).toBe("completed");
      expect(lead.gatesNote).toBe(unsure.summary);
    }
    const blank = briefGateAction({ verdict: "unsure", summary: "  " }, 0);
    if (blank.action !== "unsure") throw new Error("expected unsure");
    expect(blank.apply(done()).gatesNote).toBe("The checks couldn't say the brief was met.");
  });

  it("a verdict that isn't passed or failed is unsure, never a pass", () => {
    const step = briefGateAction({ verdict: "not-run", summary: "Routes check not run: no script." }, 0);
    expect(step.action).toBe("unsure");
  });
});

describe("running them", () => {
  const input = {
    delegationId: "t-1",
    checkout: "/code/tally worktrees/mc-1",
    projectId: "tally",
    signedOff: false,
    report: "Done.",
    failures: 0,
  };

  it("no stored plan leaves the routes check to run as before", async () => {
    expect(await briefGatesFor(input, async () => null)).toBeNull();
  });

  it("a check that throws is unsure, not a pass", async () => {
    const step = await briefGatesFor(input, async () => {
      throw new Error("the app was gone");
    });
    expect(step?.action).toBe("unsure");
    if (step?.action !== "unsure") return;
    const lead = step.apply(done());
    expect(lead.status).toBe("completed");
    expect(lead.gatesNote).toMatch(/isn't done until you decide/);
    expect(lead.gatesNote).not.toContain("the app was gone");
  });

  it("uses the record it was given", async () => {
    expect((await briefGatesFor(input, async () => passed))?.action).toBe("pass");
    expect((await briefGatesFor(input, async () => failed))?.action).toBe("resend");
    expect((await briefGatesFor({ ...input, failures: 1 }, async () => failed))?.action).toBe("fail");
  });
});

describe("the report its first mate reads", () => {
  it("says a task isn't done, and only when the checks couldn't decide", () => {
    const plain = completionMessage("r1", [done()]);
    expect(plain.text).not.toContain("task_accept");
    expect(plain.text).not.toContain("NOT DONE");
    const held = completionMessage("r2", [done({ gatesNote: unsure.summary })]);
    expect(held.text).toContain(
      `NOT DONE: Add tally delete finished, but the checks couldn't say the brief was met (${unsure.summary}). Accept or refuse with task_accept; don't report it as done.`,
    );
    expect(held.monoSessionCompletion?.status).toBe("completed");
  });
});

it("the app runs a brief's gates first and keeps the routes check for a brief that has none", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../../../app/App.tsx"), "utf8");
  expect(app).toMatch(/WP-40:/);
  expect(app).toMatch(/briefGatesFor\(/);
  expect(app).toMatch(/if \(gateDue\(result\)\) \{/);
  expect(app).toMatch(/runWorkerGate\(\{ projectId, checkout, signedOff: signedOffFor\(workerStarted, monoId, /);
  expect(app).toMatch(/submitSessionRef\.current\(sessionId, gateAsk\(run\), \[\], \{/);
  expect(app).toMatch(/finish\(gateFailedResult\(result, run\)\)/);
});
