// PM 22 Oct: the Since paragraph said "0 stuck or failed" (Ash OS's words) and then "1 failed: Tidy Hivra README…"
// (the app's). The count and the list now come from one place: Ash OS's own stuck talk is left out, and its stuck jobs
// join the app's workers in the app's one sentence.
import { describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import type { StuckWorker } from "../../monos/model/workerStuck";
import { appSinceText, withoutStuckTalk } from "./appSince";

const SINCE = 1_000_000_000;
const row = (id: string, patch: Partial<Delegation> = {}): Delegation => ({
  id, ownerSession: "hivra-chat", ownerMono: "hivra-lead", batchId: null, parentId: null, rootId: id, childSession: `w-${id}`,
  requestId: id, generation: 1, project: "hivra", title: `Job ${id}`, brief: null, goal: null, askIds: [], state: "running",
  errorClass: null, error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null, delivery: "pending",
  deliveryMessage: null, createdAt: SINCE - 10, updatedAt: SINCE + 1000, settledAt: null, log: [], version: 1,
  mirroredVersion: 0, mirrorError: null, ...patch,
});
const failedReadme = row("r", { title: "Tidy Hivra README setup steps", state: "failed", settledAt: SINCE + 500 });
const stuck: StuckWorker = { row: failedReadme, kind: "failed", line: "", since: SINCE + 500, escalated: true, key: "r" };

describe("one count and one list for stuck or failed work", () => {
  it("drops Ash OS's own stuck talk, zero counts too, and keeps the rest of its words", () => {
    expect(withoutStuckTalk("Hivra: 3 things finished and 0 got stuck. 0 stuck or failed. EXO decided the boss.")).toBe(
      "Hivra: 3 things finished. EXO decided the boss.",
    );
    expect(withoutStuckTalk("Nothing got stuck or failed.")).toBe("");
    expect(withoutStuckTalk("2 jobs failed in Nibbii.")).toBe("");
  });

  it("lists Ash OS's stuck jobs with the app's workers, each once, under one count", () => {
    const text = appSinceText({
      sinceMs: SINCE, rows: [failedReadme], stuck: [stuck], changes: [], nameOf: () => "Hivra lead",
      jobs: [
        { title: "Tidy Hivra README setup steps", failed: true, at: SINCE + 600 },
        { title: "Fix the waitlist email", failed: true, at: SINCE + 700 },
        { title: "Move the nightly backup", failed: false, at: SINCE + 800 },
        { title: "Old one", failed: true, at: SINCE - 1 },
      ],
    });
    expect(text).toContain("2 failed: Tidy Hivra README setup steps and Fix the waitlist email.");
    expect(text).toContain("1 got stuck or asked for an answer: Move the nightly backup.");
    expect(text).not.toContain("Old one");
    expect(text).not.toMatch(/\b0 /);
  });
});
