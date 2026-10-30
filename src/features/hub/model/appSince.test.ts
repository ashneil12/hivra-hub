// C9: the app's share of Today's "Since …" paragraph, from real events only, and nothing when nothing happened.
import { describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import type { StuckWorker } from "../../monos/model/workerStuck";
import { appSinceText, sinceGlance, sinceParagraph } from "./appSince";

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
      "EXO Lead handed out 3 jobs and Chief of Staff 1. One is done and reported back: Wire the dodge input. " +
        "1 failed and is with its Lead: Upload the build. 1 is with its Lead or waiting on an answer: Pick the dodge timing. " +
        "Alfred made 1 change to how it works, each with Undo in Bot changes.",
    );
  });

  it("never repeats what was already stuck before Ash was last active: that is a standing reminder, and it's in Today's lists", () => {
    const old = row("5", { title: "Example: stuck since yesterday", state: "question", createdAt: SINCE - 9000 });
    const before: StuckWorker = { ...stuck(old, "asking"), since: SINCE - 5000 };
    const failedBefore: StuckWorker = { ...stuck(row("6", { createdAt: SINCE - 9000, state: "failed" }), "failed"), since: SINCE - 1 };
    expect(appSinceText({ sinceMs: SINCE, rows: [old], stuck: [before, failedBefore], changes: [], nameOf })).toBe("");
  });

  it("says the Lead handed out N jobs and all N are done, with a capital L (Critiquito, 29 Oct)", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(String(n), { title: `T${n}`, state: "completed", settledAt: SINCE + n, delivery: "acknowledged" }));
    const tally = (_row: Delegation) => "Tally lead";
    expect(appSinceText({ sinceMs: SINCE, rows, stuck: [], changes: [], nameOf: tally })).toBe("The Lead handed out 5 jobs and all 5 are done: T1, T2 and 3 more.");
    expect(appSinceText({ sinceMs: SINCE, rows: rows.slice(0, 1), stuck: [], changes: [], nameOf: tally })).toBe("The Lead handed out 1 job and it is done: T1.");
  });

  it("says back, not done, while the Lead's own turn is still checking them (r81, c02 r80)", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(String(n), { title: `T${n}`, state: "completed", settledAt: SINCE + n, delivery: "acknowledged" }));
    const tally = (_row: Delegation) => "Tally lead";
    expect(appSinceText({ sinceMs: SINCE, rows, stuck: [], changes: [], nameOf: tally, checking: () => true })).toBe(
      "The Lead handed out 5 jobs and all 5 are back and still being checked: T1, T2 and 3 more.",
    );
    expect(appSinceText({ sinceMs: SINCE, rows, stuck: [], changes: [], nameOf: tally, checking: () => false })).toBe(
      "The Lead handed out 5 jobs and all 5 are done: T1, T2 and 3 more.",
    );
  });

  it("says a job stopped on Ash's choice, not done, while its Lead waits on him (r83, s14 r82)", () => {
    const rows = [row("1", { title: "Delete junk tallies", state: "completed", settledAt: SINCE + 1, delivery: "delivered" })];
    const tally = (_row: Delegation) => "Tally lead";
    const text = appSinceText({ sinceMs: SINCE, rows, stuck: [], changes: [], nameOf: tally, awaitingAsh: () => true });
    expect(text).toBe("The Lead handed out 1 job and it stopped on a choice that is yours: Delete junk tallies.");
    expect(text).not.toMatch(/\bdone\b/);
    expect(appSinceText({ sinceMs: SINCE, rows, stuck: [], changes: [], nameOf: tally, awaitingAsh: () => false })).toBe(
      "The Lead handed out 1 job and it is done: Delete junk tallies.",
    );
  });

  it("drops Ash OS's 'Nothing new here' when the app has news, and keeps it when there is none", () => {
    expect(sinceParagraph("Nothing new here since then.", "The Lead handed out 1 job and it is done: T1.")).toBe("The Lead handed out 1 job and it is done: T1.");
    expect(sinceParagraph("Nothing new here since then.", "")).toBe("Nothing new here since then.");
    expect(sinceParagraph("The build finished.", "The Lead handed out 1 job.")).toBe("The build finished. The Lead handed out 1 job.");
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

describe("sinceGlance", () => {
  it("keeps what happened and drops standing reminders and PR lists (C9: Ash, no PR lists, no standing reminders)", () => {
    const ashOs =
      "Example: EXO's dodge landed and the playtest build is up. 102 things are waiting on you. " +
      "Merged PRs: #412, #415 and #418. Hivra's waitlist email went to 40 people. Don't forget the vendor renewal.";
    expect(sinceGlance(ashOs)).toBe("Example: EXO's dodge landed and the playtest build is up. Hivra's waitlist email went to 40 people.");
  });
  it("leaves a plain paragraph as it is, and an all-reminder one empty", () => {
    expect(sinceGlance("Example: the build finished. Alfred tidied the notes.")).toBe("Example: the build finished. Alfred tidied the notes.");
    expect(sinceGlance("Nothing finished and nothing new was decided. Nothing is waiting on you.")).toBe("Nothing finished and nothing new was decided.");
    expect(sinceGlance("3 asks are still open.")).toBe("");
  });
});
