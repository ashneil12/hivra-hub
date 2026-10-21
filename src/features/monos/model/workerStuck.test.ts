// One answer to "which workers are stuck, and how" for every surface (the Lead's chat, the rail, Being built, Today,
// the notification): a worker asking its Lead, one that stalled, one that failed. Before this each surface had its own
// idea (the rail: question or failed; Being built: whatever Ash OS's job said, where a running sibling hid a failure).
import { describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import {
  ASK_ESCALATE_MS,
  plainReason,
  storedQuestion,
  delegationLine,
  dismissStuck,
  leadRollup,
  resetStuckDismissals,
  stuckForJob,
  stuckWorkers,
  workCounts,
  workSplit,
} from "./workerStuck";

const MIN = 60_000;
const NOW = 100 * MIN;

function row(patch: Partial<Delegation> & Pick<Delegation, "id">): Delegation {
  return {
    ownerSession: "lead-chat",
    ownerMono: "vg-game-lead",
    batchId: null,
    parentId: null,
    rootId: patch.id,
    childSession: `w-${patch.id}`,
    requestId: `r-${patch.id}`,
    generation: 1,
    project: "/repo",
    title: `Job ${patch.id}`,
    brief: null,
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: 10 * MIN,
    updatedAt: 10 * MIN,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...patch,
  };
}

const asking = (id: string, at: number) =>
  row({ id, state: "question", pendingQuestion: "Which save format? [JSON | binary]", log: [{ at, by: "worker", event: "asked" }] });

describe("stuckWorkers", () => {
  it("names each stuck worker once, by how it is stuck, oldest first; running and finished ones are not stuck", () => {
    resetStuckDismissals();
    const rows = [
      row({ id: "run" }),
      asking("ask", NOW - 30_000),
      row({ id: "quiet", stallKind: "quiet", stallReason: "Still running npm test", stalledAt: NOW - 9 * MIN }),
      row({ id: "fail", state: "failed", errorClass: "usage_limit", error: "402", settledAt: NOW - 2 * MIN, delivery: "delivered" }),
      row({ id: "done", state: "completed", settledAt: NOW - MIN }),
      row({ id: "stop", state: "cancelled", settledAt: NOW - MIN }),
    ];
    const stuck = stuckWorkers(rows, NOW);
    expect(stuck.map((s) => [s.row.id, s.kind])).toEqual([
      ["quiet", "stalled"],
      ["fail", "failed"],
      ["ask", "asking"],
    ]);
    expect(stuck.find((s) => s.kind === "stalled")?.line).toBe("No output for 9 min · still running the tests");
    expect(stuck.find((s) => s.kind === "failed")?.line).toBe("Failed: usage limit reached");
    expect(stuck.find((s) => s.kind === "asking")?.line).toBe("Which save format? [JSON | binary]");
  });

  it("a worker's question stays its Lead's however long it sits (D5: the Lead asks Ash in its own chat); stalled and failed are escalated", () => {
    const fresh = stuckWorkers([asking("a", NOW - 30_000)], NOW)[0];
    expect(fresh.escalated).toBe(false);
    const old = stuckWorkers([asking("a", NOW - 10 * ASK_ESCALATE_MS)], NOW)[0];
    expect(old.escalated).toBe(false);
    const stalled = stuckWorkers([row({ id: "s", stallKind: "idle", stallReason: "Stopped without reporting back", stalledAt: NOW - 7 * MIN })], NOW)[0];
    expect(stalled).toMatchObject({ escalated: true, line: "Stopped without reporting back · 7 min ago" });
    const failed = stuckWorkers([row({ id: "f", state: "failed", error: "The build broke. Then more.", settledAt: NOW })], NOW)[0];
    expect(failed).toMatchObject({ escalated: true, line: "Failed: the build broke" });
  });

  it("a failure says why, with the reset time of a limit, and never fails silently", () => {
    const resetsAt = new Date(2026, 9, 20, 15, 10).getTime();
    const limit = stuckWorkers([row({ id: "f", state: "failed", errorClass: "usage_limit", resetsAt, settledAt: NOW })], NOW)[0];
    expect(limit.line).toBe("Failed: usage limit reached, resets 3:10pm");
    const billing = stuckWorkers([row({ id: "b", state: "failed", errorClass: "billing", error: "402 Payment Required", settledAt: NOW })], NOW)[0];
    expect(billing.line).toBe("Failed: billing refused");
    const nothing = stuckWorkers([row({ id: "n", state: "failed", settledAt: NOW })], NOW)[0];
    expect(nothing.line).toBe("Failed: it stopped without saying why");
  });

  it("a failure stops being stuck when Ash dismisses it, a later try in that chat replaces it, or it is old", () => {
    resetStuckDismissals();
    const failed = row({ id: "f", state: "failed", settledAt: NOW - MIN });
    expect(stuckWorkers([failed], NOW)).toHaveLength(1);
    expect(stuckWorkers([failed, row({ id: "again", childSession: failed.childSession, createdAt: NOW })], NOW)).toHaveLength(0);
    expect(stuckWorkers([{ ...failed, settledAt: NOW - 7 * 60 * MIN }], NOW)).toHaveLength(0);
    dismissStuck(stuckWorkers([failed], NOW)[0].key);
    expect(stuckWorkers([failed], NOW)).toHaveLength(0);
    // Failing again later is new.
    expect(stuckWorkers([{ ...failed, generation: 2, settledAt: NOW }], NOW)).toHaveLength(1);
    resetStuckDismissals();
  });
});

describe("storedQuestion", () => {
  it("reads a question as its row stores it, without the marker, with the worker's pick", () => {
    expect(storedQuestion("How long? [0.25 s (Recommended) | 0.4 s]")).toEqual({ text: "How long? [0.25 s | 0.4 s]", pick: "0.25 s" });
    expect(storedQuestion("Which? [a | b]")).toEqual({ text: "Which? [a | b]" });
    expect(storedQuestion("One? [a (Recommended) | b] / Two? [c | d (Recommended)]").pick).toBeUndefined();
    expect(storedQuestion(null)).toEqual({ text: "" });
  });
});

describe("what a Lead's work reads as", () => {
  const rows = [
    row({ id: "w1" }),
    row({ id: "w2", stallKind: "loop", stallReason: "Repeating the same step: the tests (6 times)", stalledAt: NOW }),
    asking("w3", NOW),
    row({ id: "w4", state: "failed", settledAt: NOW - MIN, createdAt: 20 * MIN }),
    row({ id: "w5", state: "completed", settledAt: NOW - MIN, createdAt: 20 * MIN }),
    row({ id: "old", state: "completed", settledAt: 5 * MIN, createdAt: MIN }),
    row({ id: "x", ownerSession: "other" }),
  ];

  it("splits what is out into working, asking and stuck (stalled or failed)", () => {
    expect(workCounts("lead-chat", rows, NOW)).toEqual({ working: 1, asking: 1, stuck: 2 });
    expect(workSplit(workCounts("lead-chat", rows, NOW))).toBe("1 working · 1 asking · 2 stuck");
    expect(workSplit({ working: 2, asking: 0, stuck: 0 })).toBe("2 working");
    expect(workSplit({ working: 0, asking: 0, stuck: 0 })).toBeUndefined();
  });

  it("counts the Lead's current wave the way its batch line does, never just 'busy'", () => {
    expect(leadRollup("lead-chat", rows, NOW)).toBe("Delegated 5: 1 working, 1 asking, 1 stuck, 1 failed, 1 done");
    expect(leadRollup("other", rows, NOW)).toBe("Delegated 1: 1 working");
    expect(leadRollup("nobody", rows, NOW)).toBeUndefined();
    // Nothing out and nothing stuck: no line.
    expect(leadRollup("lead-chat", [row({ id: "d", state: "completed", settledAt: NOW })], NOW)).toBeUndefined();
  });

  it("reads one row as its state word for the rail", () => {
    expect(delegationLine(rows[1], NOW)).toBe("Repeating the same step: the tests (6 times)");
    // How long it has run is never part of the state word (runningFor, shown muted on its own).
    expect(delegationLine(rows[0], NOW)).toBe("working");
  });
});

describe("stuckForJob: a running sibling never hides a stuck worker", () => {
  const top = row({ id: "t-top", ownerSession: "cos-chat", childSession: "lead-chat", askIds: ["a_1"], follow: "lead" });
  const rows = [
    top,
    row({ id: "t-a", parentId: "t-top", rootId: "t-top" }),
    row({ id: "t-b", parentId: "t-top", rootId: "t-top", state: "failed", settledAt: NOW, errorClass: "billing" }),
    row({ id: "t-c", parentId: "t-b", rootId: "t-top", stallKind: "quiet", stalledAt: NOW - 8 * MIN, stallReason: "" }),
  ];

  it("finds the most urgent stuck worker under a job by its source, by delegation or by ask", () => {
    expect(stuckForJob("delegation:t-top", rows, NOW)?.row.id).toBe("t-b");
    expect(stuckForJob("ask:a_1", rows, NOW)?.row.id).toBe("t-b");
    expect(stuckForJob("ask:a_other", rows, NOW)).toBeUndefined();
    expect(stuckForJob(undefined, rows, NOW)).toBeUndefined();
    const onlyStalled = rows.filter((r) => r.id !== "t-b").map((r) => (r.id === "t-c" ? { ...r, parentId: "t-a" } : r));
    expect(stuckForJob("delegation:t-top", onlyStalled, NOW)?.row.id).toBe("t-c");
  });
});

describe("plainReason", () => {
  it("says the commands a stall names in plain words", () => {
    expect(plainReason("Still running npm test")).toBe("Still running the tests");
    expect(plainReason("still running npx vitest run src/a.test.ts")).toBe("still running the tests src/a.test.ts");
    expect(plainReason("Waiting on cargo build")).toBe("Waiting on the build");
    expect(plainReason("Stuck in npm install")).toBe("Stuck in an install");
    expect(plainReason("Waiting on a permission")).toBe("Waiting on a permission");
  });
});

// Live 22 Oct (D5): the worker's question showed twice in the Lead's chat, once as the Lead's own question and once as
// the worker's asking card. While the Lead asks, only its question shows; stalled and failed workers still do.
it("a Lead asking Ash itself hides its workers' asking cards, never a stalled or failed one", async () => {
  const { stuckShownInLeadChat } = await import("./workerStuck");
  const stuck = [{ kind: "asking" as const, id: "q" }, { kind: "stalled" as const, id: "s" }, { kind: "failed" as const, id: "f" }];
  expect(stuckShownInLeadChat(stuck, true).map((s) => s.id)).toEqual(["s", "f"]);
  expect(stuckShownInLeadChat(stuck, false).map((s) => s.id)).toEqual(["q", "s", "f"]);
});
