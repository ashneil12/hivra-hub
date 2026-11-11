// @vitest-environment happy-dom
// WP-176: a spend limit holds a new builder and leaves a running one alone.
import { beforeEach, describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import {
  admitWorker,
  enqueueWorker,
  nextWorkers,
  projectLoad,
  queuedLine,
  queuedWorkers,
  resetWorkerPool,
  setBuilderHealth,
  spendHold,
  type ProviderRoom,
  type QueuedWorker,
} from "./workerPool";
import {
  forgetSpendMemory,
  judgeLaunch,
  resetSpendGate,
  reviewReportedTurn,
  saveSpendLimit,
  saveTaskCeiling,
  setSpendClock,
  setSpendSessions,
  setSpendWarnSink,
  spendSnapshot,
  setSpendProjectLookup,
} from "../../usage/model/spendGate";
import type { UsageSession } from "../../usage/model/history";

const month = Date.parse("2026-11-10T15:00:00");
const nextMonth = Date.parse("2026-12-01T00:30:00");
const room = (): ProviderRoom => ({ room: true });
const open = (child: string) =>
  ({ childSession: child, project: "hivra", state: "running", follow: null }) as Pick<
    Delegation,
    "project" | "state" | "childSession" | "follow"
  >;
const ask = {
  id: "new",
  project: "hivra",
  projectName: "Hivra",
  heavy: false,
  harness: "claude",
  ownerSession: "lead-chat",
};
const job = (id: string): QueuedWorker => ({
  id,
  ownerSession: "lead-chat",
  requestId: id,
  project: "hivra",
  projectName: "Hivra",
  title: id,
  heavy: false,
  harness: "claude",
  queuedAt: 0,
  input: { brief: id },
});

function sessions(costUsd: number, cwd = "/work/monocode-hub"): UsageSession[] {
  return [
    {
      id: "chat",
      cwd,
      harness: "claude",
      model: "opus",
      blocks: [{ id: "t1", role: "user", startedAt: month, turnMetrics: { costUsd, inputTokens: 10 } }],
    },
  ];
}

beforeEach(() => {
  localStorage.clear();
  resetWorkerPool();
  resetSpendGate();
  setSpendClock(() => month);
  setSpendProjectLookup({
    idOf: (folder) => (folder === "/work/monocode-hub" ? "hivra" : undefined),
    folderOf: (id) => (id === "hivra" ? "/work/monocode-hub" : undefined),
  });
  setBuilderHealth({ freeDiskGb: 100, freeMemoryGb: 16, load1: 1, cores: 8, readAt: month, now: month });
});

describe("a spend limit at the launch gate", () => {
  it("starts exactly as before when no limit is set", () => {
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });
    expect(judgeLaunch({ project: "hivra", harness: "claude" })).toEqual({ status: "unset", reason: "" });
  });

  it("refuses a new launch with the over reason and does not touch a running builder", () => {
    setSpendSessions(sessions(50));
    const saved = saveSpendLimit(
      { scope: "project", project: "hivra", period: "month", amountUsd: 50, warnAt: 0.8 },
      0,
    );
    expect(saved.written).toBe(true);
    const rows = [open("run-1")];
    const before = rows.map((row) => ({ ...row }));
    const refused = admitWorker(ask, { rows, room });
    expect(refused).toEqual({
      start: false,
      reason: "spend",
      line: "Spend limit reached for hivra: $50 of $50 this month. Raise it, or wait for the month to reset. Estimated from Claude Code's price table.",
    });
    expect(rows).toEqual(before);
    expect(projectLoad("hivra", rows as Delegation[]).running).toBe(1);
    expect(refused.line).not.toMatch(/[—–]/);
    expect(refused.line).not.toMatch(/kill|refund|bill/i);
  });

  it("lets the queued builder start once the cap is raised or the month resets", async () => {
    setSpendSessions(sessions(50));
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 50, warnAt: 0.8 }, 0);
    await enqueueWorker(job("app-lead-chat-q1"));
    expect(nextWorkers({ rows: [], room })).toEqual([]);
    expect(spendHold()?.text).toContain("Spend limit reached for hivra");
    expect(spendHold()?.action).toBe("Raise limit");
    expect(queuedLine(queuedWorkers()[0], { rows: [], room })).toContain("Spend limit reached");
    const raised = saveSpendLimit(
      { scope: "project", project: "hivra", period: "month", amountUsd: 80, warnAt: 0.8 },
      spendSnapshot().book.revision,
    );
    expect(raised.written).toBe(true);
    expect(nextWorkers({ rows: [], room }).map((row) => row.id)).toEqual(["app-lead-chat-q1"]);
    saveSpendLimit(
      { scope: "project", project: "hivra", period: "month", amountUsd: 50, warnAt: 0.8 },
      spendSnapshot().book.revision,
    );
    expect(nextWorkers({ rows: [], room })).toEqual([]);
    setSpendClock(() => nextMonth);
    expect(nextWorkers({ rows: [], room }).map((row) => row.id)).toEqual(["app-lead-chat-q1"]);
  });

  it("a CLI that reports no cost is refused once the limit is over, and says the limit cannot count it under it", () => {
    // MEDIUM 8: switching to a CLI with no cost does not get round a limit that is already reached.
    setSpendSessions(sessions(80));
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0);
    const refused = admitWorker({ ...ask, harness: "codex" }, { rows: [], room });
    expect(refused).toMatchObject({ start: false, reason: "spend" });
    setSpendSessions(sessions(1));
    const started = admitWorker({ ...ask, harness: "codex" }, { rows: [], room });
    expect(started).toEqual({
      start: true,
      line: "This CLI reports no cost, so this limit cannot count its work.",
    });
  });

  it("holds a new launch when the rows cannot be read, and an empty read is zero", () => {
    setSpendSessions(null);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0);
    const held = admitWorker(ask, { rows: [], room });
    expect(held.start).toBe(false);
    if (!held.start) expect(held.line).toContain("could not be read");
    setSpendSessions([]);
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });
  });

  it("warns the first mate once per period and still starts", async () => {
    setSpendSessions(sessions(41));
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 50, warnAt: 0.8 }, 0);
    const seen: string[] = [];
    setSpendWarnSink({
      wake: async (input) => {
        seen.push(input.key);
        return { fresh: seen.filter((key) => key === input.key).length === 1 };
      },
      activity: () => undefined,
    });
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["spend-warn:project:hivra:2026-11"]);
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["spend-warn:project:hivra:2026-11"]);
  });

  it("keeps the disk pause ahead of the spend limit", () => {
    setBuilderHealth({ freeDiskGb: 10, readAt: month, now: month });
    setSpendSessions(sessions(50));
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 50, warnAt: 0.8 }, 0);
    const held = admitWorker(ask, { rows: [], room });
    expect(held).toMatchObject({ start: false, reason: "health" });
    if (!held.start) expect(held.line).toContain("Free disk");
  });

  it("still shows the same total after the in-memory book is forgotten", () => {
    setSpendSessions(sessions(50));
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 50, warnAt: 0.8 }, 0);
    expect(admitWorker(ask, { rows: [], room }).start).toBe(false);
    const raw = localStorage.getItem("monocode:spend-limits") ?? "";
    expect(raw).not.toContain("measuredUsd");
    expect(raw).not.toContain("50 of");
    forgetSpendMemory();
    const again = admitWorker(ask, { rows: [], room });
    expect(again.start).toBe(false);
    if (!again.start) expect(again.line).toContain("$50 of $50");
  });

  it("a stale revision does not raise the cap", () => {
    setSpendSessions([]);
    const first = saveSpendLimit(
      { scope: "project", project: "hivra", period: "month", amountUsd: 20, warnAt: 0.8 },
      0,
    );
    const lost = saveSpendLimit(
      { scope: "project", project: "hivra", period: "month", amountUsd: 100, warnAt: 0.8 },
      0,
    );
    expect(lost.written).toBe(false);
    expect(lost.book.limits[0]?.amountUsd).toBe(20);
    expect(first.book.revision).toBe(1);
  });
});

describe("a per-task ceiling at the end of a billed turn", () => {
  it("asks once, then stops only that run, and the next local day starts again", () => {
    saveTaskCeiling("hivra", { hardUsd: 1, softAt: 0.5, dailyUsd: 2 }, 0);
    setSpendSessions([]);
    const first = reviewReportedTurn({
      sessionId: "custom-run",
      cwd: "/work/monocode-hub",
      model: "custom:missing",
      harness: "claude",
      metrics: { costUsd: 0.6, inputTokens: 3 },
      unattended: true,
    });
    expect(first.ask).toBe(true);
    expect(first.stopRun).toBe(false);
    const second = reviewReportedTurn({
      sessionId: "custom-run",
      cwd: "/work/monocode-hub",
      model: "custom:missing",
      harness: "claude",
      metrics: { costUsd: 0.5, inputTokens: 3 },
      unattended: true,
    });
    expect(second.stopRun).toBe(true);
    expect(second.reason).toContain("Task ceiling reached");
    const subscription = reviewReportedTurn({
      sessionId: "sub",
      cwd: "/work/monocode-hub",
      model: "opus",
      harness: "claude",
      metrics: { costUsd: 9, inputTokens: 3 },
    });
    expect(subscription).toMatchObject({ status: "unset", stopRun: false });
    setSpendClock(() => nextMonth);
    const tomorrow = reviewReportedTurn({
      sessionId: "custom-next",
      cwd: "/work/monocode-hub",
      model: "custom:missing",
      harness: "claude",
      metrics: { costUsd: 0.2, inputTokens: 1 },
      unattended: true,
    });
    expect(tomorrow.stopRun).toBe(false);
    expect(tomorrow.ask).toBe(false);
  });
});
