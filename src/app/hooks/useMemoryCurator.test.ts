// @vitest-environment happy-dom

import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no app")) }));

import { backgroundAskFits, budgetedAsk, curatorAsk, mayTryAgain, curatorFeeds, firstDeferral, lastExchange } from "./useMemoryCurator";
import { cheapAsk } from "../../features/memory/model/cheapAsk";
import { collectAnswer, curateTurn } from "../../features/memory/model/curator";
import { emptyDoc } from "../../features/memory/model/doc";
import { BUDGET_KEY, PAUSE_KEY, loadBudget, pausedNow } from "../../features/memory/model/memoryBudget";

const NOW = Date.parse("2026-06-01T12:00:00Z");
const HOUR = 3_600_000;

beforeEach(() => localStorage.clear());

it("curates a finished first-mate turn once, and not a worker or a busy chat", () => {
  const fed = new Map<string, string | undefined>();
  const mateOf = (id: string) => (id === "lead-chat" ? "notes-lead" : undefined);
  const chat = (id: string, busy = false) => ({
    id,
    busy,
    blocks: [
      { id: "u", role: "user", text: "I like small commits" },
      { id: "a", role: "assistant", text: "Noted." },
    ],
  });
  expect(curatorFeeds([chat("lead-chat"), chat("worker")], fed, mateOf).map((feed) => feed.turnId)).toEqual(["a"]);
  expect(curatorFeeds([chat("lead-chat")], fed, mateOf)).toEqual([]);
  expect(curatorFeeds([chat("lead-chat", true)], new Map(), mateOf)).toEqual([]);
  // WP-111: a private chat is never read, by the model curator or the rules curator (both use this list).
  const fedPrivate = new Map<string, string | undefined>();
  expect(curatorFeeds([{ ...chat("lead-chat"), private: true }], fedPrivate, mateOf)).toEqual([]);
  expect(fedPrivate.size).toBe(0);
  // An old chat with no flag is still read.
  expect(curatorFeeds([chat("lead-chat")], new Map(), mateOf).map((feed) => feed.turnId)).toEqual(["a"]);
  // After it is switched off, only an exchange past the boundary is read. The boundary message itself is not.
  const opened = {
    ...chat("lead-chat"),
    privateBoundaryId: "a",
    blocks: [
      { id: "u", role: "user", text: "secret" },
      { id: "a", role: "assistant", text: "Noted." },
      { id: "u2", role: "user", text: "I like small commits" },
      { id: "a2", role: "assistant", text: "Noted again." },
    ],
  };
  expect(curatorFeeds([opened], new Map(), mateOf).map((feed) => feed.turnId)).toEqual(["a2"]);
  expect(curatorFeeds([{ ...opened, privateBoundaryId: "missing" }], new Map(), mateOf)).toEqual([]);
  expect(lastExchange([{ id: "u", role: "user", text: "hi" }, { id: "a", role: "assistant", text: "ok", streaming: true }])).toBeUndefined();
  expect(lastExchange([{ id: "t", role: "tool", text: "x".repeat(100) }])).toBeUndefined();
  expect(lastExchange([])).toBeUndefined();
});

it("asks nobody on the rules tier, and the crew on the others", async () => {
  const turn = { user: "Remember that the release branch is called ship.", assistant: "Noted." };
  const answer = await curatorAsk("rules", turn)("the whole prompt");
  expect(answer.ok && answer.text).toBe(
    JSON.stringify({ kind: "add", text: "The release branch is called ship.", evidence: "Remember that the release branch is called ship." }),
  );
  // A quiet turn says none, so settleTurn finishes it without an item.
  const quiet = await curatorAsk("rules", { user: "Thanks.", assistant: "" })("");
  expect(quiet.ok && quiet.text).toBe('{"kind":"none"}');
});

it("defers on the cheap tier when the picked model is gone, rather than crashing", async () => {
  const answer = await curatorAsk("cheap", { user: "Remember that it rains.", assistant: "" }, "xai-gone")("p");
  expect(answer).toMatchObject({ ok: false, kind: "timeout" });
});

it("the background budget: rules spends nothing, and a crew turn leaves the pause for the screen", () => {
  // Rules never calls a model, so an hour already spent does not hold it back.
  localStorage.setItem(BUDGET_KEY, JSON.stringify(Array.from({ length: 30 }, (_, i) => NOW - i * 1000)));
  expect(backgroundAskFits("rules", undefined, NOW)).toBe(true);
  expect(pausedNow(NOW)).toBeUndefined();

  // Crew is over the hourly limit: the turn is left for later, and the screen is told when it opens again.
  expect(backgroundAskFits("crew", undefined, NOW)).toBe(false);
  expect(pausedNow(NOW)).toEqual({ problem: "hour", until: NOW - 29_000 + HOUR });

  // A cheap tier with no model picked would spend nothing, so the budget does not turn it away.
  localStorage.clear();
  localStorage.setItem(BUDGET_KEY, JSON.stringify(Array.from({ length: 30 }, (_, i) => NOW - i * 1000)));
  expect(backgroundAskFits("cheap", undefined, NOW)).toBe(true);
});

it("the background budget counts a call when it is taken", () => {
  expect(loadBudget(NOW)).toEqual([]);
  expect(backgroundAskFits("crew", undefined, NOW)).toBe(true);
  expect(loadBudget(NOW)).toEqual([NOW]);
  // A ledger that cannot be read means no budget: nothing is called, and the screen says why.
  localStorage.setItem(BUDGET_KEY, "not json");
  expect(backgroundAskFits("crew", undefined, NOW + 1)).toBe(false);
  expect(pausedNow(NOW + 1)).toMatchObject({ problem: "storage" });
});

it("counts a deferred turn the first time it is left for later, and not on every retry", () => {
  const counted = new Set<string>();
  expect(firstDeferral(counted, "notes-lead:turn-1")).toBe(true);
  expect(firstDeferral(counted, "notes-lead:turn-1")).toBe(false);
  expect(firstDeferral(counted, "notes-lead:turn-2")).toBe(true);
  // A different Mono's turn is its own.
  expect(firstDeferral(counted, "other-lead:turn-1")).toBe(true);
  // The set stays bounded however long a session runs.
  const long = new Set<string>();
  for (let i = 0; i < 700; i++) firstDeferral(long, `turn-${i}`);
  expect(long.size).toBeLessThanOrEqual(500);
  expect(firstDeferral(long, "turn-699")).toBe(false);
});

it("a pause is gone from the screen once its moment has passed", () => {
  localStorage.setItem(BUDGET_KEY, JSON.stringify(Array.from({ length: 30 }, (_, i) => NOW - i * 1000)));
  expect(backgroundAskFits("crew", undefined, NOW)).toBe(false);
  expect(localStorage.getItem(PAUSE_KEY)).not.toBeNull();
  expect(pausedNow(NOW + HOUR)).toBeUndefined();
});

it("an already-done turn charges nothing, because the budget is taken inside the ask", async () => {
  const doc = { ...emptyDoc(), doneTurns: ["notes-lead:turn-1"] };
  const inner = vi.fn(async () => ({ ok: true as const, text: '{"kind":"none"}' }));
  const ask = budgetedAsk("crew", undefined, inner, () => {}, () => NOW);
  const ctx = { mateId: "notes-lead", turnId: "turn-1", user: "Remember that it rains.", assistant: "", now: NOW };
  expect((await collectAnswer(doc, ctx, ask)).kind).toBe("already");
  expect((await collectAnswer(emptyDoc(), { ...ctx, user: "" }, ask)).kind).toBe("empty");
  expect(inner).not.toHaveBeenCalled();
  expect(loadBudget(NOW)).toEqual([]);
  // A real call is charged once, at the call.
  expect((await collectAnswer(emptyDoc(), { ...ctx, turnId: "turn-2" }, ask)).kind).toBe("reply");
  expect(loadBudget(NOW)).toEqual([NOW]);
});

it("a refused cheap-model outcome is final: not deferred, and a second change makes no call", async () => {
  localStorage.setItem(
    "monocode:custom-models",
    JSON.stringify([{ id: "deepseek-def456", name: "DeepSeek chat", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" }]),
  );
  const call = vi.fn(async () => ({ ok: false, text: "", kind: "refused", reason: "That model turned this down." }));
  const ask = budgetedAsk("cheap", "deepseek-def456", cheapAsk("deepseek-def456", call), () => {}, () => NOW);
  const ctx = { mateId: "notes-lead", turnId: "turn-1", user: "Remember that it rains.", assistant: "", now: NOW };
  const first = await curateTurn(emptyDoc(), ctx, ask);
  expect(first.answer.kind).toBe("refused");
  expect(first.outcome.status).not.toBe("deferred");
  // The next chat-list change finds the turn done and asks nothing.
  await curateTurn(first.doc, ctx, ask);
  expect(call).toHaveBeenCalledTimes(1);
  expect(loadBudget(NOW)).toEqual([NOW]);
});

it("a turn that keeps failing for a passing reason is tried twice, then left alone", () => {
  const tries = new Map<string, number>();
  expect(mayTryAgain(tries, "notes-lead:turn-1")).toBe(true);
  expect(mayTryAgain(tries, "notes-lead:turn-1")).toBe(false);
  expect(mayTryAgain(tries, "notes-lead:turn-2")).toBe(true);
});

it("WP-240: a chat that leaves the list or is hidden has closed, and is read one last time; a busy one has not", async () => {
  const { trackChats, batchChats } = await import("./useMemoryCurator");
  const mateOf = (id: string) => (id.startsWith("lead") ? "notes-lead" : undefined);
  const chat = (id: string, extra: { busy?: boolean; sidebarHidden?: boolean } = {}) => ({
    id,
    ...extra,
    blocks: [{ id: `${id}-u`, role: "user", text: "We ship on Fridays." }],
  });
  const known = new Map();
  expect(trackChats(known, [chat("lead-1"), chat("lead-2"), chat("worker")], mateOf)).toEqual([]);
  expect([...known.keys()]).toEqual(["lead-1", "lead-2"]);
  // Busy is still open.
  expect(trackChats(known, [chat("lead-1", { busy: true }), chat("lead-2")], mateOf)).toEqual([]);
  const closed = trackChats(known, [chat("lead-1", { sidebarHidden: true })], mateOf);
  expect(closed.map((one) => one.sessionId).sort()).toEqual(["lead-1", "lead-2"]);
  // The batch reads the closed chats beside the open ones, once each.
  expect(batchChats([chat("lead-3")], mateOf, closed).map((one) => one.sessionId)).toEqual(["lead-3", "lead-1", "lead-2"]);
});
