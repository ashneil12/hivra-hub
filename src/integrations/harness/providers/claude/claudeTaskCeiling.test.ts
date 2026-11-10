// @vitest-environment happy-dom
// WP-176. A billed run is judged when Claude reports the turn's cost. The figure
// is a fixture. Nothing here calls a billed API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";
import {
  ceilingHold,
  resetSpendGate,
  saveSpendLimit,
  saveTaskCeiling,
  setSpendClock,
  setSpendSessions,
  spendSnapshot,
} from "../../../../features/usage/model/spendGate";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (value: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import("./claude");

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

function interrupted(): boolean {
  return parse().some((message) => {
    const request = message.request as Record<string, unknown> | undefined;
    return message.type === "control_request" && request?.subtype === "interrupt";
  });
}

async function startTurn(sessionId: string, model: string) {
  const events: HarnessEvent[] = [];
  const from = sent.length;
  const fresh = !onLine;
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model,
    modelSettings: {},
    runtimeMode: "full-access",
    text: "do the work",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  if (fresh) {
    await waitFor(
      () => parse().slice(from).some((message) => (message.request as { subtype?: string } | undefined)?.subtype === "initialize"),
      "initialize",
    );
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit({ type: "control_response", response: { subtype: "success", request_id: "monocode_1" } });
  }
  await waitFor(() => parse().slice(from).some((message) => message.type === "user"), "user prompt");
  return { events, turn };
}

function report(costUsd: number) {
  emit({
    type: "result",
    subtype: "success",
    session_id: "sess_1",
    is_error: false,
    result: "done",
    total_cost_usd: costUsd,
    usage: { input_tokens: 10, output_tokens: 4 },
  });
}

const BILLED = "custom:paid";

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  __claudeTestReset();
  resetSpendGate();
  setSpendClock(() => Date.parse("2026-11-10T15:00:00"));
  setSpendSessions([]);
});

afterEach(async () => {
  await stopClaudeSession("ceiling-chat");
  await stopClaudeSession("app-night");
  await stopClaudeSession("plain-chat");
  resetSpendGate();
});

describe("a billed Claude turn and its ceiling", () => {
  it("asks once near the ceiling and does not stop the run", async () => {
    saveTaskCeiling("/repo", { hardUsd: 1, softAt: 0.8 }, spendSnapshot().book.revision);
    const first = await startTurn("ceiling-chat", BILLED);
    report(0.85);
    await first.turn;
    expect(first.events.some((event) => event.type === "status" && event.text.includes("Continue?"))).toBe(true);
    expect(first.events.some((event) => event.type === "session.error")).toBe(false);
    expect(interrupted()).toBe(false);
    expect(ceilingHold("ceiling-chat")).toBeUndefined();

    const second = await startTurn("ceiling-chat", BILLED);
    report(0.9);
    await second.turn;
    expect(second.events.some((event) => event.type === "status" && event.text.includes("Continue?"))).toBe(false);
    expect(interrupted()).toBe(false);
  });

  it("stops that run once the reported total passes the hard cap, and the turn still settles", async () => {
    saveTaskCeiling("/repo", { hardUsd: 1, softAt: 0.8 }, spendSnapshot().book.revision);
    const { events, turn } = await startTurn("ceiling-chat", BILLED);
    report(1.2);
    await turn;
    const error = events.find((event) => event.type === "session.error");
    expect(error && error.type === "session.error" ? error.message : "").toContain("Task ceiling reached");
    expect(ceilingHold("ceiling-chat")).toContain("Task ceiling reached");
    await waitFor(() => interrupted(), "interrupt");
  });

  it("leaves a subscription CLI and a project limit alone", async () => {
    saveTaskCeiling("/repo", { hardUsd: 1 }, spendSnapshot().book.revision);
    const subscription = await startTurn("ceiling-chat", "claude:claude-sonnet-5");
    report(50);
    await subscription.turn;
    expect(subscription.events.some((event) => event.type === "session.error")).toBe(false);
    expect(interrupted()).toBe(false);

    await stopClaudeSession("ceiling-chat");
    onLine = undefined;
    resetSpendGate();
    setSpendClock(() => Date.parse("2026-11-10T15:00:00"));
    setSpendSessions([]);
    saveSpendLimit(
      { scope: "project", project: "/repo", period: "month", amountUsd: 1, warnAt: 0.8 },
      spendSnapshot().book.revision,
    );
    const limited = await startTurn("plain-chat", BILLED);
    report(50);
    await limited.turn;
    expect(limited.events.some((event) => event.type === "session.error")).toBe(false);
    expect(interrupted()).toBe(false);
    expect(ceilingHold("plain-chat")).toBeUndefined();
  });

  it("stops an unattended run at the daily ceiling and lets an attended one pass", async () => {
    saveTaskCeiling("/repo", { dailyUsd: 1 }, spendSnapshot().book.revision);
    const night = await startTurn("app-night", BILLED);
    report(2);
    await night.turn;
    expect(night.events.some((event) => event.type === "session.error" && event.message.includes("Daily ceiling"))).toBe(true);
    await waitFor(() => interrupted(), "interrupt");

    await stopClaudeSession("app-night");
    onLine = undefined;
    sent.length = 0;
    resetSpendGate();
    setSpendClock(() => Date.parse("2026-11-10T15:00:00"));
    setSpendSessions([]);
    saveTaskCeiling("/repo", { dailyUsd: 1 }, spendSnapshot().book.revision);
    const day = await startTurn("plain-chat", BILLED);
    report(2);
    await day.turn;
    expect(day.events.some((event) => event.type === "session.error")).toBe(false);
    expect(interrupted()).toBe(false);
  });
});
