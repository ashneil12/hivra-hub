// @vitest-environment happy-dom
// WP-176 re-review (CRITICAL A): the app's wiring reads the ledger through the app's commands and writes each turn.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: unknown }[] = [];
const now = Date.parse("2026-11-10T15:00:00");

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    if (cmd === "spend_ledger_totals") {
      return [{ projectKey: "hivra", sessionId: "chat", day: "2026-11-10", micros: 50_000_000, priced: 1, unpriced: 0 }];
    }
    if (cmd === "spend_project_folder") return "/Users/ash/Projects/monocode-hub";
    return undefined;
  }),
}));

import { wireSpendGate } from "./spendWiring";
import {
  admitSpendTurn,
  judgeLaunch,
  resetSpendGate,
  reviewReportedTurn,
  saveSpendLimit,
  setSpendClock,
} from "./spendGate";

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  resetSpendGate();
  setSpendClock(() => now);
  wireSpendGate();
});

describe("wireSpendGate", () => {
  it("reads the ledger through the app's command, so a limit judges real spend", async () => {
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    // Nothing read yet: the gate does not guess.
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
    await flush();
    expect(calls.some((call) => call.cmd === "spend_ledger_totals" && typeof (call.args as { since: number }).since === "number")).toBe(true);
    // $50 measured against $10: over, for real.
    expect(judgeLaunch({ project: "hivra", harness: "claude" })).toMatchObject({ status: "over" });
  });

  it("writes each measured turn to the ledger with its project key", async () => {
    reviewReportedTurn({ sessionId: "s9", cwd: "/Users/ash/Projects/monocode-hub-worktrees/feat", model: "custom:acme", harness: "claude", metrics: { costUsd: 1.25 } });
    await flush();
    const append = calls.find((call) => call.cmd === "spend_ledger_append");
    expect(append).toBeDefined();
    expect((append!.args as { entry: unknown }).entry).toMatchObject({ sessionId: "s9", micros: 1_250_000, priced: true });
  });

  it("asks git for a working copy's project when a turn is admitted, so a pool slot counts", async () => {
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    await admitSpendTurn({ sessionId: "x", cwd: "/Users/ash/Worktrees/pool/monocode-hub-slot1", harness: "claude" });
    expect(calls.some((call) => call.cmd === "spend_project_folder")).toBe(true);
  });
});
