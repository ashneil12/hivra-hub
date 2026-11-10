import { describe, expect, it } from "vitest";
import { ceilingDecision, sanitizeTaskCeiling } from "./taskCeiling";
import { periodSpend } from "./spend";
import type { UsageSession } from "./history";

const soft = { hardUsd: 10, softAt: 0.8, dailyUsd: 4 };

describe("per-task ceiling", () => {
  it("stays off until the person sets one, and never applies to a subscription CLI", () => {
    expect(sanitizeTaskCeiling({})).toBeNull();
    expect(sanitizeTaskCeiling({ hardUsd: 0 })).toBeNull();
    expect(sanitizeTaskCeiling({ hardUsd: -1 })).toBeNull();
    expect(sanitizeTaskCeiling({ hardUsd: "10" })).toBeNull();
    expect(sanitizeTaskCeiling(soft)).toMatchObject(soft);
    expect(ceilingDecision({ ceiling: null, billed: true, reportsCost: true, taskMeasuredUsd: 100, taskPricedTurns: 1, taskUnpricedTurns: 0, dailyMeasuredUsd: 100, unattended: true, asked: false, continued: false }).status).toBe("unset");
    const subscription = ceilingDecision({
      ceiling: soft,
      billed: false,
      reportsCost: true,
      taskMeasuredUsd: 100,
      taskPricedTurns: 1,
      taskUnpricedTurns: 0,
      dailyMeasuredUsd: 100,
      unattended: true,
      asked: false,
      continued: false,
    });
    expect(subscription.stopRun).toBe(false);
    expect(subscription.status).toBe("unset");
  });

  it("asks once at the soft share, and the hard cap stops only that run", () => {
    const under = ceilingDecision({
      ceiling: soft,
      billed: true,
      reportsCost: true,
      taskMeasuredUsd: 7,
      taskPricedTurns: 1,
      taskUnpricedTurns: 0,
      dailyMeasuredUsd: 1,
      unattended: false,
      asked: false,
      continued: false,
    });
    expect(under.status).toBe("ok");
    const ask = ceilingDecision({
      ceiling: soft,
      billed: true,
      reportsCost: true,
      taskMeasuredUsd: 8,
      taskPricedTurns: 1,
      taskUnpricedTurns: 0,
      dailyMeasuredUsd: 1,
      unattended: false,
      asked: false,
      continued: false,
    });
    expect(ask.status).toBe("ask");
    expect(ask.ask).toBe(true);
    expect(ask.stopRun).toBe(false);
    const again = ceilingDecision({ ...askInput(8), asked: true });
    expect(again.ask).toBe(false);
    expect(again.stopRun).toBe(false);
    const wentOn = ceilingDecision({ ...askInput(8), asked: true, continued: true });
    expect(wentOn.status).toBe("ok");
    const hard = ceilingDecision({ ...askInput(10), asked: true, continued: true });
    expect(hard.status).toBe("stop");
    expect(hard.stopRun).toBe(true);
    expect(hard.reason).toContain("$10");
  });

  it("resets the daily unattended total at local midnight", () => {
    const night = Date.parse("2026-11-10T23:40:00");
    const morning = Date.parse("2026-11-11T00:20:00");
    const rows: UsageSession[] = [
      {
        id: "run",
        cwd: "/work/hivra",
        harness: "claude",
        model: "custom:paid",
        blocks: [
          { id: "a", role: "user", startedAt: Date.parse("2026-11-10T23:30:00"), turnMetrics: { costUsd: 3, inputTokens: 1 } },
          { id: "b", role: "user", startedAt: morning, turnMetrics: { costUsd: 0.5, inputTokens: 1 } },
        ],
      },
    ];
    const before = periodSpend([rows[0] && { ...rows[0], blocks: rows[0].blocks.slice(0, 1) }].filter(Boolean) as UsageSession[], {
      now: night,
      period: "day",
      match: () => true,
    });
    const after = periodSpend(rows, { now: morning, period: "day", match: () => true });
    expect(before.measuredUsd).toBeCloseTo(3, 6);
    expect(after.measuredUsd).toBeCloseTo(0.5, 6);
    const stopped = ceilingDecision({
      ceiling: { dailyUsd: 2 },
      billed: true,
      reportsCost: true,
      taskMeasuredUsd: 0,
      taskPricedTurns: 0,
      taskUnpricedTurns: 0,
      dailyMeasuredUsd: before.measuredUsd,
      unattended: true,
      asked: false,
      continued: false,
    });
    expect(stopped.stopRun).toBe(true);
    const lifted = ceilingDecision({
      ceiling: { dailyUsd: 2 },
      billed: true,
      reportsCost: true,
      taskMeasuredUsd: 0,
      taskPricedTurns: 0,
      taskUnpricedTurns: 0,
      dailyMeasuredUsd: after.measuredUsd,
      unattended: true,
      asked: false,
      continued: false,
    });
    expect(lifted.stopRun).toBe(false);
    const attended = ceilingDecision({
      ceiling: { dailyUsd: 2 },
      billed: true,
      reportsCost: true,
      taskMeasuredUsd: 0,
      taskPricedTurns: 0,
      taskUnpricedTurns: 0,
      dailyMeasuredUsd: 9,
      unattended: false,
      asked: false,
      continued: false,
    });
    expect(attended.stopRun).toBe(false);
  });
});

function askInput(taskMeasuredUsd: number) {
  return {
    ceiling: soft,
    billed: true,
    reportsCost: true,
    taskMeasuredUsd,
    taskPricedTurns: 1,
    taskUnpricedTurns: 0,
    dailyMeasuredUsd: 1,
    unattended: false,
    asked: false,
    continued: false,
  };
}
