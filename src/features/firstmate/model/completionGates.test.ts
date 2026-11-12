// Hivra WP-40: a finished report is done only when the gates passed. One failure goes back to the worker; the next
// fails. Unsure, or a check that couldn't run, is not a pass and is not another fix round.
import { describe, expect, it } from "vitest";
import { completionMessage, type MonoSessionCompletionResult } from "../../monos/model/monoSessionCompletion";
import { GATE_TRIES } from "../../monos/model/workerGate";
import type { Block } from "../../sessions/model/session";
import { briefGateAction, briefGatesFor, gateRequest, type BriefGateInput, type GateRecordView } from "./completionGates";

function block(partial: Partial<Block> & Pick<Block, "role">): Block {
  return { id: partial.id ?? partial.role, text: partial.text ?? "", ...partial };
}

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

  it("a sent-back failure names the reason, once, then fails the report", () => {
    const summary = "Sent back: tests went stale after the last edit.";
    const first = briefGateAction({ verdict: "failed", summary }, 0);
    expect(first.action).toBe("resend");
    if (first.action !== "resend") return;
    expect(first.note.line).toBe(summary);
    expect(first.ask).toContain(summary);
    expect(first.failed(done()).error).toBe(`${summary} Still failed after 2 tries.`);

    const listed = [
      "Sent back: a check failed this turn (npm test). Also 1 more.",
      "A check failed this turn (npm test).",
      "Tests went stale after the last edit.",
    ].join("\n");
    const again = briefGateAction({ verdict: "failed", summary: listed }, 0);
    if (again.action !== "resend") throw new Error("expected resend");
    expect(again.note.line).toBe("Sent back: a check failed this turn (npm test). Also 1 more.");
    expect(again.ask).toContain("Tests went stale after the last edit.");

    const second = briefGateAction({ verdict: "failed", summary }, 1);
    expect(second.action).toBe("fail");
    if (second.action !== "fail") return;
    expect(second.apply(done()).error).toBe(`${summary} Still failed after 2 tries.`);
    expect(second.apply(done()).status).toBe("failed");
  });

  it("a sent-back line with nothing after it, a control character, or a line too long keeps the usual note", () => {
    const usual = "Checks failed; their words went back to the worker";
    for (const summary of ["Sent back:", "Sent back:   ", "Sent back: tests\u0007failed.", `Sent back: ${"x".repeat(200)}`]) {
      const step = briefGateAction({ verdict: "failed", summary }, 0);
      if (step.action !== "resend") throw new Error(summary);
      expect(step.note.line, summary).toBe(usual);
    }
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

  it("reads facts from this turn only, and does not invent them when the blocks are missing", async () => {
    let missing: BriefGateInput | undefined;
    await briefGatesFor({ ...input, report: "The tests passed." }, async (got) => {
      missing = got;
      return null;
    });
    expect(missing?.facts).toBeUndefined();

    const blocks: Block[] = [
      block({ role: "user", text: "earlier" }),
      block({ role: "tool", tool: { command: "cargo test", status: "failed" } }),
      block({ role: "user", text: "again" }),
      block({ role: "tool", tool: { command: "npm test", status: "completed" } }),
    ];
    let seen: BriefGateInput | undefined;
    await briefGatesFor({ ...input, blocks, report: "Done." }, async (got) => {
      seen = got;
      return null;
    });
    expect(seen?.facts?.checks).toEqual([{ command: "npm test", status: "passed", at: 0 }]);
    expect(seen?.facts?.answer).toBe("Done.");

    const kept = { checks: [], edits: [], todos: [], answer: "kept" };
    let given: BriefGateInput | undefined;
    await briefGatesFor({ ...input, blocks, facts: kept }, async (got) => {
      given = got;
      return null;
    });
    expect(given?.facts).toEqual(kept);
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
