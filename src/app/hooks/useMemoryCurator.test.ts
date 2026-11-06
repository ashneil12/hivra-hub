import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no app")) }));

import { curatorAsk, curatorFeeds, lastExchange } from "./useMemoryCurator";

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
