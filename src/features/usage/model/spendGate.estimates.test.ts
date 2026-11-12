// @vitest-environment happy-dom
// WP-253: a list-price estimate is shown on the Usage page only. Spend limits count what the engines reported, so a
// turn with no reported price stays unpriced here even when its model has a listed price.
import { beforeEach, describe, expect, it } from "vitest";
import { buildUsageHistory, type UsageSession } from "./history";
import { resetSpendGate, sessionTotal, setSpendClock, setSpendSessions } from "./spendGate";

const now = Date.parse("2026-11-10T15:00:00");

const chat: UsageSession = {
  id: "chat",
  cwd: "/work/app",
  harness: "codex",
  model: "opus-5-5",
  blocks: [{ id: "t", role: "user", startedAt: now, turnMetrics: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }],
};

beforeEach(() => {
  localStorage.clear();
  resetSpendGate();
  setSpendClock(() => now);
});

describe("spend limits ignore list-price estimates", () => {
  it("keeps an estimated turn at no spend and unpriced", () => {
    // The Usage page estimates this turn at $24.
    expect(buildUsageHistory([chat], { now }).today.estimatedUsd).toBeCloseTo(24, 6);
    setSpendSessions([chat]);
    const total = sessionTotal("chat");
    expect(total.micros).toBe(0);
    expect(total.priced).toBe(0);
    expect(total.unpriced).toBe(1);
  });
});
