import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no app")) }));
import { treeFeeds } from "./useMonoTrees";

it("feeds only an idle long-chat Mono's own chat, once per new last block", () => {
  const fed = new Map<string, string | undefined>();
  const monoOf = (id: string) => (id === "hivra-chat" ? { id: "hivra", longChat: true } : id === "frank-chat" ? { id: "frank" } : undefined);
  const chat = (id: string, last: string, busy = false) => ({ id, busy, blocks: [{ id: last, role: "user" as const, text: "x" }] });
  expect(treeFeeds([chat("hivra-chat", "b1"), chat("frank-chat", "f1"), chat("worker", "w1")], fed, monoOf).map((f) => f.monoId)).toEqual(["hivra"]);
  expect(treeFeeds([chat("hivra-chat", "b1")], fed, monoOf)).toEqual([]);
  expect(treeFeeds([chat("hivra-chat", "b2", true)], fed, monoOf)).toEqual([]);
  expect(treeFeeds([chat("hivra-chat", "b2")], fed, monoOf).length).toBe(1);
});
