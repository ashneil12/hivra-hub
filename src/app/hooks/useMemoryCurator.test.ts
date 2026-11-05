import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no app")) }));

import { curatorFeeds, lastExchange } from "./useMemoryCurator";

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
