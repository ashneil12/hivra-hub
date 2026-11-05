import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no app")) }));
import { treeFeeds } from "./useMonoTrees";

it("feeds only an idle long-chat Mono's own chat, once per new last block", () => {
  const fed = new Map<string, string | undefined>();
  const monoOf = (id: string) => (id === "hivra-chat" ? { id: "hivra", longChat: true } : id === "ed-chat" ? { id: "ed" } : undefined);
  const chat = (id: string, last: string, busy = false) => ({ id, busy, blocks: [{ id: last, role: "user" as const, text: "x" }] });
  expect(treeFeeds([chat("hivra-chat", "b1"), chat("ed-chat", "f1"), chat("worker", "w1")], fed, monoOf).map((f) => f.monoId)).toEqual(["hivra"]);
  expect(treeFeeds([chat("hivra-chat", "b1")], fed, monoOf)).toEqual([]);
  expect(treeFeeds([chat("hivra-chat", "b2", true)], fed, monoOf)).toEqual([]);
  expect(treeFeeds([chat("hivra-chat", "b2")], fed, monoOf).length).toBe(1);
});

it("feeds a first mate past the size, and not a short chat or a room", () => {
  const fed = new Map<string, string | undefined>();
  const big = "x".repeat(16_000);
  const monoOf = (id: string) => {
    if (id === "own" || id === "tiny") return { id: "notes-lead", sessionId: id };
    if (id === "room") return { id: "notes-lead", sessionId: "other" };
    return undefined;
  };
  const leadOf = (id: string) => (id === "team" ? "proj-lead" : undefined);
  const chat = (id: string, text: string) => ({ id, busy: false, blocks: [{ id: "b", role: "user" as const, text }] });
  const feeds = treeFeeds(
    [chat("own", big), chat("tiny", "hi"), chat("room", big), chat("team", big), chat("other", big)],
    fed,
    monoOf,
    leadOf,
  );
  expect(feeds.map((feed) => [feed.monoId, feed.evenWithoutSetting, feed.session.id])).toEqual([
    ["notes-lead", true, "own"],
    ["proj-lead", true, "team"],
  ]);
});
