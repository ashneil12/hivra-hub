// C9: the app's share of Today's "Since …" paragraph, from real events only, and nothing when nothing happened.
import { describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import type { StuckWorker } from "../../monos/model/workerStuck";
import { appSinceText } from "./appSince";

const SINCE = 1_000_000_000;
function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "exo-chat", ownerMono: "exo", batchId: null, parentId: null, rootId: id, childSession: `w-${id}`,
    requestId: id, generation: 1, project: "vg-game", title: `Job ${id}`, brief: null, goal: null, askIds: [], state: "running",
    errorClass: null, error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null, delivery: "pending",
    deliveryMessage: null, createdAt: SINCE + 1000, updatedAt: SINCE + 1000, settledAt: null, log: [], version: 1,
    mirroredVersion: 0, mirrorError: null, ...patch,
  };
}
const stuck = (r: Delegation, kind: StuckWorker["kind"]): StuckWorker => ({ row: r, kind, line: "", since: SINCE, escalated: true, key: r.id });
const names: Record<string, string> = { "exo-chat": "EXO lead", "cos-chat": "Chief of Staff" };
const nameOf = (r: Delegation) => names[r.ownerSession] ?? "its Lead";

describe("appSinceText", () => {
  it("says nothing when nothing happened since Ash was last active", () => {
    const old = row("1", { createdAt: SINCE - 5000, state: "completed", settledAt: SINCE - 1000, delivery: "acknowledged" });
    expect(appSinceText({ sinceMs: SINCE, rows: [old], stuck: [], changes: [], nameOf })).toBe("");
  });

  it("names what was handed out, what finished and reported back, what is stuck or failed, and Bot changes", () => {
    const done = row("1", { title: "Wire the dodge input", state: "completed", settledAt: SINCE + 5000, delivery: "acknowledged" });
    const asking = row("2", { title: "Pick the dodge timing", state: "question" });
    const failed = row("3", { title: "Upload the build", state: "failed", settledAt: SINCE + 6000 });
    const cos = row("4", { ownerSession: "cos-chat", title: "Price the competitors" });
    const text = appSinceText({
      sinceMs: SINCE,
      rows: [done, asking, failed, cos],
      stuck: [stuck(asking, "asking"), stuck(failed, "failed")],
      changes: [{ bot: "Alfred", line: "Alfred changed how it reviews" }],
      nameOf,
    });
    expect(text).toBe(
      "EXO lead handed out 3 jobs and Chief of Staff 1. One finished and reported back: Wire the dodge input. " +
        "1 is stuck or waiting on an answer: Pick the dodge timing. 1 failed: Upload the build. " +
        "Alfred made 1 change to how it works, each with Undo in Bot changes.",
    );
  });

  it("says a finished job hasn't reported back yet plainly, and lists long sets briefly", () => {
    const rows = [1, 2, 3, 4].map((n) => row(String(n), { title: `T${n}`, state: "completed", settledAt: SINCE + n, createdAt: SINCE - 10 }));
    expect(appSinceText({ sinceMs: SINCE, rows, stuck: [], changes: [], nameOf })).toBe("4 finished: T1, T2 and 2 more.");
  });
});

describe("botChangesSince", () => {
  it("keeps the time a change was made, and lists only the ones since, still standing", async () => {
    const { botChangesSince, recordPageChange } = await import("./botChanges");
    const before = Date.now();
    recordPageChange("p-since", "Alfred", "Weekly numbers");
    const found = botChangesSince(before).filter((c) => c.pageId === "p-since");
    expect(found).toHaveLength(1);
    expect(found[0].at).toBeGreaterThanOrEqual(before);
    expect(botChangesSince(Date.now() + 60_000).some((c) => c.pageId === "p-since")).toBe(false);
  });
});
