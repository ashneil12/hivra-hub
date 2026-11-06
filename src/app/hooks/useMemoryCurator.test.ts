// @vitest-environment happy-dom

import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no app")) }));

import { backgroundAskFits, curatorAsk, curatorFeeds, lastExchange } from "./useMemoryCurator";
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
  // A shipped budget that cannot be written still lets the turn through: it is a limit, not a lock.
  localStorage.setItem(BUDGET_KEY, "not json");
  expect(backgroundAskFits("crew", undefined, NOW + 1)).toBe(true);
});

it("a pause is gone from the screen once its moment has passed", () => {
  localStorage.setItem(BUDGET_KEY, JSON.stringify(Array.from({ length: 30 }, (_, i) => NOW - i * 1000)));
  expect(backgroundAskFits("crew", undefined, NOW)).toBe(false);
  expect(localStorage.getItem(PAUSE_KEY)).not.toBeNull();
  expect(pausedNow(NOW + HOUR)).toBeUndefined();
});
