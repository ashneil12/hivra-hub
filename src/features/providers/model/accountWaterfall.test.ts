// @vitest-environment happy-dom
// Board E5: several Claude accounts, used in Ash's order, moving on when one runs out and coming back when it resets.
// Usage readings are fakes (what the usage probe would have cached); limit errors are the CLI's own recorded results
// (fixtures/claude-cli-2.1.302) put through the real failure classifier and session reducer.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { claudeFailureFromResult } from "../../../integrations/harness/providers/claude/claudeFailure";
import { newSession, type Session } from "../../sessions/model/session";
import {
  accountAvailability,
  firstTurnAccount,
  reactToLimit,
  limitMarks,
  markAccountLimited,
  moveAccount,
  orderedAccounts,
  planWaterfall,
  setWaterfallEnabled,
  startAccount,
  waterfallEnabled,
  type UsageFor,
} from "./accountWaterfall";
import type { ProviderRateLimits } from "./rateLimits";
import { providerAccounts, saveProviderAccount, type ProviderAccount } from "./providerAccounts";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 21, 10, 0);

function reading(sessionUsed: number, weeklyUsed = 10, { updatedAt = NOW, resetsIn = 2 * HOUR, status = "ok" as ProviderRateLimits["status"] } = {}): ProviderRateLimits {
  return {
    provider: "claude",
    session: { usedPercent: sessionUsed, windowMinutes: 300, resetsAt: NOW + resetsIn },
    weekly: { usedPercent: weeklyUsed, windowMinutes: 10_080, resetsAt: NOW + 3 * 24 * HOUR },
    monthly: null,
    resetCredits: null,
    updatedAt,
    error: status === "unavailable" ? "Not signed in" : null,
    status,
  };
}
const readings = (map: Record<string, ProviderRateLimits | undefined>): UsageFor => (account) => map[account.id];

function threeAccounts(): ProviderAccount[] {
  saveProviderAccount({ id: "account-b", provider: "claude", label: "Account 2" });
  saveProviderAccount({ id: "account-c", provider: "claude", label: "Personal" });
  return orderedAccounts("claude");
}

/** The CLI's own result line from a recorded run. */
function recordedResult(name: string): Record<string, unknown> {
  const file = path.join(__dirname, "../../../integrations/harness/providers/claude/fixtures/claude-cli-2.1.302", name);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return lines.filter((line) => line.type === "result").at(-1)!;
}

/** A chat on `accountId` whose turn the provider just refused with `result` (what claude.ts does with it). */
function refusedChat(accountId: string, result: Record<string, unknown>): Session {
  const failure = claudeFailureFromResult(result, { now: NOW });
  expect(failure).not.toBeNull();
  const chat = { ...newSession("claude", "/tmp/tally"), providerAccountId: accountId, providerSessionId: "p-1", busy: true };
  const failed = applyHarnessEvent(chat, { type: "session.error", message: failure!.message, errorClass: failure!.errorClass, resetsAt: failure!.resetsAt });
  return { ...failed, busy: false };
}

beforeEach(() => localStorage.clear());

describe("the order", () => {
  it("starts as the accounts are listed, and Ash can move one up or down", () => {
    const order = threeAccounts();
    expect(order.map((a) => a.id)).toEqual(["default", "account-b", "account-c"]);
    moveAccount("claude", "account-c", -1);
    expect(orderedAccounts("claude").map((a) => a.id)).toEqual(["default", "account-c", "account-b"]);
    moveAccount("claude", "default", 1);
    expect(orderedAccounts("claude").map((a) => a.id)).toEqual(["account-c", "default", "account-b"]);
    moveAccount("claude", "account-c", -1); // already first: nothing changes
    expect(orderedAccounts("claude").map((a) => a.id)).toEqual(["account-c", "default", "account-b"]);
  });

  it("forgets removed accounts and puts new ones last", () => {
    threeAccounts();
    moveAccount("claude", "account-c", -1);
    const listed = providerAccounts("claude").filter((a) => a.id !== "account-b");
    saveProviderAccount({ id: "account-d", provider: "claude", label: "Spare" });
    expect(orderedAccounts("claude", [...listed, { id: "account-d", provider: "claude", label: "Spare" }]).map((a) => a.id)).toEqual(["default", "account-c", "account-d"]);
  });

  it("moving on is on unless Ash turns it off", () => {
    expect(waterfallEnabled("claude")).toBe(true);
    setWaterfallEnabled("claude", false);
    expect(waterfallEnabled("claude")).toBe(false);
    expect(waterfallEnabled("codex")).toBe(true);
  });
});

describe("a chat that hits its limit", () => {
  it("moves to the next account with room when Claude refuses for the usage limit, and says so in one plain line", () => {
    const order = threeAccounts();
    const chat = refusedChat("default", recordedResult("503-gateway-429-limit.ndjson"));
    expect(chat.usageLimit).toBeDefined();
    const plan = planWaterfall(chat, "claude", { order, enabled: true, now: NOW, usageFor: readings({ default: reading(100), "account-b": reading(30) }), marks: limitMarks() });
    expect(plan).toEqual({ action: "move", to: "account-b", line: "Claude account 1 hit its limit, so this chat moved to account 2." });
  });

  it("skips an account that is spent too, and names accounts Ash named", () => {
    const order = threeAccounts();
    const chat = refusedChat("default", recordedResult("503-gateway-429-limit.ndjson"));
    const plan = planWaterfall(chat, "claude", { order, enabled: true, now: NOW, usageFor: readings({ "account-b": reading(40, 100) }), marks: limitMarks() });
    expect(plan).toEqual({ action: "move", to: "account-c", line: "Claude account 1 hit its limit, so this chat moved to account 3 (Personal)." });
  });

  it("skips an account whose CLI isn't signed in", () => {
    const order = threeAccounts();
    const chat = refusedChat("default", recordedResult("503-gateway-429-limit.ndjson"));
    const plan = planWaterfall(chat, "claude", { order, enabled: true, now: NOW, usageFor: readings({ "account-b": reading(0, 0, { status: "unavailable" }) }), marks: limitMarks() });
    expect(plan).toMatchObject({ action: "move", to: "account-c" });
  });

  it("stays put when every other account is out, when there is one account, or when Ash turned it off", () => {
    const order = threeAccounts();
    const chat = refusedChat("default", recordedResult("503-gateway-429-limit.ndjson"));
    const allSpent = readings({ default: reading(100), "account-b": reading(100), "account-c": reading(20, 100) });
    expect(planWaterfall(chat, "claude", { order, enabled: true, now: NOW, usageFor: allSpent, marks: {} })).toEqual({ action: "stay", reason: "none-free" });
    expect(planWaterfall(chat, "claude", { order: order.slice(0, 1), enabled: true, now: NOW, usageFor: readings({}), marks: {} })).toEqual({ action: "stay", reason: "single-account" });
    expect(planWaterfall(chat, "claude", { order, enabled: false, now: NOW, usageFor: readings({}), marks: {} })).toEqual({ action: "stay", reason: "off" });
  });

  it("doesn't move for a billing refusal: that isn't a limit that resets", () => {
    const order = threeAccounts();
    const chat = refusedChat("default", recordedResult("402-billing.ndjson"));
    expect(chat.usageLimit).toBeUndefined();
    expect(planWaterfall(chat, "claude", { order, enabled: true, now: NOW, usageFor: readings({}), marks: {} })).toEqual({ action: "stay", reason: "not-limited" });
  });

  it("waits for the turn to be over before moving", () => {
    const order = threeAccounts();
    const chat = { ...refusedChat("default", recordedResult("503-gateway-429-limit.ndjson")), busy: true };
    expect(planWaterfall(chat, "claude", { order, enabled: true, now: NOW, usageFor: readings({}), marks: {} })).toEqual({ action: "stay", reason: "busy" });
  });
});

describe("new chats and the account coming back", () => {
  it("a new chat starts on the next account while the first is out, and on the first again once its window resets", () => {
    const order = threeAccounts();
    const resetsAt = NOW + 2 * HOUR;
    markAccountLimited(order[0], { now: NOW, resetsAt });
    const before = startAccount("claude", "default", { order, enabled: true, now: NOW + HOUR, usageFor: readings({}), marks: limitMarks() });
    expect(before).toEqual({ id: "account-b", line: "Claude account 1 is at its limit, so this chat started on account 2." });
    // The window resets: account 1 rejoins by itself, nothing to clear.
    expect(startAccount("claude", "default", { order, enabled: true, now: resetsAt + 1, usageFor: readings({}), marks: limitMarks() })).toEqual({ id: "default" });
  });

  it("rejoins early when a fresh reading shows room again", () => {
    const order = threeAccounts();
    markAccountLimited(order[0], { now: NOW });
    const marks = limitMarks();
    expect(marks["claude:default"].until).toBe(NOW + 5 * HOUR); // no reset time known: sits out a 5-hour window
    expect(accountAvailability(order[0], { now: NOW + HOUR, usageFor: readings({ default: reading(100, 10, { updatedAt: NOW - 1 }) }), marks })).toMatchObject({ available: false, why: "limited" });
    expect(accountAvailability(order[0], { now: NOW + HOUR, usageFor: readings({ default: reading(12, 10, { updatedAt: NOW + HOUR }) }), marks })).toEqual({ available: true });
  });

  it("uses the reading's reset time when the refusal had none, and a spent weekly window counts as out", () => {
    const order = threeAccounts();
    const weeklySpent = reading(10, 100);
    markAccountLimited(order[1], { now: NOW, reading: weeklySpent });
    expect(limitMarks()["claude:account-b"].until).toBe(weeklySpent.weekly!.resetsAt);
    expect(accountAvailability(order[2], { now: NOW, usageFor: readings({ "account-c": weeklySpent }), marks: {} })).toMatchObject({ available: false, why: "exhausted" });
  });

  it("keeps the picked account when it has room, and when every account is out", () => {
    const order = threeAccounts();
    expect(startAccount("claude", "account-c", { order, enabled: true, now: NOW, usageFor: readings({}), marks: {} })).toEqual({ id: "account-c" });
    const allOut = readings({ default: reading(100), "account-b": reading(100), "account-c": reading(100) });
    expect(startAccount("claude", "default", { order, enabled: true, now: NOW, usageFor: allOut, marks: {} })).toEqual({ id: "default" });
  });
});

describe("what the app runs (reactToLimit, firstTurnAccount)", () => {
  it("a refused chat marks its account out, moves, and the next new chat skips that account until it resets", () => {
    threeAccounts();
    const chat = refusedChat("default", recordedResult("503-gateway-429-limit.ndjson"));
    const usageFor = readings({});
    const plan = reactToLimit({ ...chat, usageLimit: { resetsAt: NOW + HOUR } }, "claude", { now: NOW, usageFor });
    expect(plan).toMatchObject({ action: "move", to: "account-b" });
    expect(firstTurnAccount("claude", "default", { now: NOW + 10 * 60_000, usageFor })).toMatchObject({ id: "account-b" });
    expect(firstTurnAccount("claude", "default", { now: NOW + HOUR + 1, usageFor })).toEqual({ id: "default" });
  });

  it("follows Ash's order and his switch", () => {
    threeAccounts();
    moveAccount("claude", "account-c", -1); // default, account-c, account-b
    const chat = refusedChat("default", recordedResult("503-gateway-429-limit.ndjson"));
    expect(reactToLimit(chat, "claude", { now: NOW, usageFor: readings({}) })).toMatchObject({ action: "move", to: "account-c", line: "Claude account 1 hit its limit, so this chat moved to account 2 (Personal)." });
    setWaterfallEnabled("claude", false);
    const again = refusedChat("account-c", recordedResult("503-gateway-429-limit.ndjson"));
    expect(reactToLimit(again, "claude", { now: NOW, usageFor: readings({}) })).toEqual({ action: "stay", reason: "off" });
  });

  it("a chat on account 2 that runs out goes back to account 1 once account 1 has reset", () => {
    const order = threeAccounts();
    markAccountLimited(order[0], { now: NOW, resetsAt: NOW + HOUR });
    const later = NOW + 2 * HOUR;
    const chat = refusedChat("account-b", recordedResult("503-gateway-429-limit.ndjson"));
    expect(reactToLimit(chat, "claude", { now: later, usageFor: readings({}) })).toMatchObject({ action: "move", to: "default", line: "Claude account 2 hit its limit, so this chat moved to account 1." });
  });
});
