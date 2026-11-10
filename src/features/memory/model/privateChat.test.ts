import { expect, it } from "vitest";
import {
  UNREADABLE_BOUNDARY,
  boundaryFromDisk,
  chatIsPrivate,
  isPrivateChat,
  learnableChats,
  livePrivateKeys,
  memoryReadableBlocks,
  privateChatKeys,
  replaceLivePrivateKeys,
  withPrivate,
  withoutPrivateChats,
} from "./privateChat";

const blocks = [
  { id: "a", text: "before" },
  { id: "b", text: "during" },
  { id: "c", text: "after" },
];

it("treats an old chat with no flag as readable", () => {
  const old = { id: "s", blocks };
  expect(isPrivateChat(old)).toBe(false);
  expect(isPrivateChat(undefined)).toBe(false);
  expect(isPrivateChat({ private: false })).toBe(false);
  expect(memoryReadableBlocks(old).map((block) => block.id)).toEqual(["a", "b", "c"]);
  expect(memoryReadableBlocks(null)).toEqual([]);
  expect(memoryReadableBlocks({ blocks: undefined })).toEqual([]);
});

it("hides every message while a chat is private", () => {
  expect(memoryReadableBlocks({ private: true, blocks })).toEqual([]);
  expect(memoryReadableBlocks({ private: true, privateBoundaryId: "a", blocks })).toEqual([]);
  expect(memoryReadableBlocks({ private: true, blocks: [] })).toEqual([]);
});

it("records the last message when a private chat is switched off, and never moves that line earlier", () => {
  const started = withPrivate({ id: "s", blocks: [] as { id: string }[] }, true);
  expect(started.private).toBe(true);
  expect(started.privateBoundaryId).toBeUndefined();
  expect(withPrivate(started, true)).toBe(started);

  const later = withPrivate({ ...started, blocks }, true);
  expect(later.private).toBe(true);
  expect(memoryReadableBlocks(later)).toEqual([]);

  const opened = withPrivate(later, false);
  expect(opened.private).toBeUndefined();
  expect(opened.privateBoundaryId).toBe("c");
  expect(memoryReadableBlocks(opened).map((block) => block.id)).toEqual([]);

  const stayed = withPrivate(opened, false);
  expect(stayed).toBe(opened);

  const again = withPrivate({ ...opened, private: true, blocks: [...blocks, { id: "d", text: "new" }] }, false);
  expect(again.privateBoundaryId).toBe("d");
  expect(memoryReadableBlocks({ ...again, blocks: [...blocks, { id: "d" }, { id: "e" }] }).map((block) => block.id)).toEqual(["e"]);
});

it("does not unlock a chat whose boundary is missing or not a real id", () => {
  expect(memoryReadableBlocks({ privateBoundaryId: "gone", blocks })).toEqual([]);
  expect(boundaryFromDisk(undefined)).toBeUndefined();
  expect(boundaryFromDisk("")).toBeUndefined();
  expect(boundaryFromDisk("  a-1 ")).toBe("a-1");
  expect(boundaryFromDisk("../x")).toBe(UNREADABLE_BOUNDARY);
  expect(boundaryFromDisk("has space")).toBe(UNREADABLE_BOUNDARY);
  expect(boundaryFromDisk(1)).toBe(UNREADABLE_BOUNDARY);
  expect(boundaryFromDisk("x".repeat(81))).toBe(UNREADABLE_BOUNDARY);
  expect(memoryReadableBlocks({ privateBoundaryId: UNREADABLE_BOUNDARY, blocks })).toEqual([]);
});

it("switching off with no messages records no boundary", () => {
  const opened = withPrivate({ private: true, blocks: [] }, false);
  expect(opened.private).toBeUndefined();
  expect(opened.privateBoundaryId).toBeUndefined();
  expect(memoryReadableBlocks({ ...opened, blocks: [{ id: "a" }] }).map((block) => block.id)).toEqual(["a"]);
});

it("keeps an earlier boundary when a private chat with no messages is switched off", () => {
  const opened = withPrivate({ private: true, privateBoundaryId: "a", blocks: [] }, false);
  expect(opened.privateBoundaryId).toBe("a");
  expect(memoryReadableBlocks({ ...opened, blocks }).map((block) => block.id)).toEqual(["b", "c"]);
});

it("recognises a private chat by its id or its provider id, and not a public one", () => {
  const keys = privateChatKeys([
    { id: "hub-1", private: true },
    { id: "hub-2", providerSessionId: "provider-2", private: true },
    { id: "hub-3", providerSessionId: "provider-3", private: false },
    { id: "", providerSessionId: "", private: true },
    { id: "hub-4", providerSessionId: null, private: true },
  ]);
  expect([...keys].sort()).toEqual(["hub-1", "hub-2", "hub-4", "provider-2"]);
  expect(chatIsPrivate(keys, [])).toBe(false);
  expect(chatIsPrivate(new Set(), ["hub-1"])).toBe(false);
  expect(chatIsPrivate(keys, ["hub-1"])).toBe(true);
  expect(chatIsPrivate(keys, ["other"])).toBe(false);
  const thread = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const codex = new Set([thread]);
  expect(chatIsPrivate(codex, [`rollout-2026-10-04T12-00-00-${thread}`])).toBe(true);
  expect(chatIsPrivate(codex, [`sessions/2026/10/04/rollout-2026-10-04T12-00-00-${thread}.jsonl`])).toBe(true);
  expect(chatIsPrivate(codex, [`rollout-2026-10-04T12-00-00-${thread}x`])).toBe(false);
  expect(chatIsPrivate(new Set(["abcdef"]), ["rollout-1-abcdef"])).toBe(false);
});

it("does not offer a private chat to history import or learn-from-chats", () => {
  const provider = "1234567890abcdef";
  const keys = new Set(["hub-1", provider]);
  const units = [
    { kind: "chat", conversation: { id: "hub-1", sourceKey: "file-a" } },
    { kind: "chat", conversation: { id: "other", sourceKey: `dir/${provider}.jsonl` } },
    { kind: "chat", conversation: { id: "public", sourceKey: "file-b" } },
    { kind: "unreadable", sourceKey: "hub-1" },
    { kind: "empty", sourceKey: "file-c" },
    { kind: "chat", conversation: { id: "short", sourceKey: "notes" } },
  ];
  expect(withoutPrivateChats(units, keys).map((unit) => unit.kind === "chat" ? unit.conversation?.id : unit.sourceKey)).toEqual([
    "public",
    "file-c",
    "short",
  ]);
  expect(withoutPrivateChats(units, new Set())).toHaveLength(units.length);
  expect(learnableChats([{ id: "hub-1" }, { id: `logs/${provider}.jsonl` }, { id: "public" }, { id: "" }], keys).map((chat) => chat.id)).toEqual([
    "public",
    "",
  ]);
  expect(chatIsPrivate(new Set(["ab"]), ["folder/ab.jsonl"])).toBe(false);
});

it("replaces the window's live keys instead of accumulating them", () => {
  replaceLivePrivateKeys(new Set(["one"]));
  replaceLivePrivateKeys(new Set(["two"]));
  expect([...livePrivateKeys()]).toEqual(["two"]);
  replaceLivePrivateKeys(null);
  expect([...livePrivateKeys()]).toEqual([]);
});
