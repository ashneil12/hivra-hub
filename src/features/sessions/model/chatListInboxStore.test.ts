// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { INBOX_STATE_KEY } from "./chatListInbox";
import {
  getInboxSnapshot,
  inboxNoticeSnapshot,
  reloadInboxFromStorage,
  resetInboxStoreForTests,
  settleChats,
  snoozeChats,
  undoInbox,
  unsettleChats,
  unsnoozeChats,
} from "./chatListInboxStore";

afterEach(() => {
  vi.restoreAllMocks();
  resetInboxStoreForTests();
});

describe("chat list inbox store", () => {
  it("settles, snoozes another chat, and undoes the snooze", () => {
    settleChats(["a"], 10);
    expect(getInboxSnapshot().chats.a).toEqual({ touch: 10, settledAt: 10 });
    expect(inboxNoticeSnapshot()?.text).toBe("Settled this chat.");
    snoozeChats(["b"], 500, 20);
    expect(getInboxSnapshot().chats.a?.settledAt).toBe(10);
    expect(getInboxSnapshot().chats.b).toEqual({ touch: 20, snoozeAt: 20, snoozeUntil: 500 });
    expect(inboxNoticeSnapshot()?.text).toContain("Snoozed this chat");
    undoInbox(30);
    expect(getInboxSnapshot().chats.b).toBeUndefined();
    expect(getInboxSnapshot().chats.a?.settledAt).toBe(10);
    expect(inboxNoticeSnapshot()).toBeNull();
  });

  it("ignores a snooze that is not later than now and shows no notice", () => {
    snoozeChats(["a"], 10, 10);
    expect(getInboxSnapshot().chats.a).toBeUndefined();
    expect(inboxNoticeSnapshot()).toBeNull();
  });

  it("reads a broken document as empty, then a settle replaces it", () => {
    localStorage.setItem(INBOX_STATE_KEY, "{nope");
    reloadInboxFromStorage();
    expect(getInboxSnapshot()).toEqual({ rev: 0, chats: {} });
    settleChats(["a"], 4);
    expect(getInboxSnapshot().rev).toBe(1);
    expect(getInboxSnapshot().chats.a?.settledAt).toBe(4);
  });

  it("follows another window and does not crash when storage throws", () => {
    settleChats(["a"], 1);
    localStorage.setItem(
      INBOX_STATE_KEY,
      JSON.stringify({ rev: 3, chats: { b: { touch: 3, settledAt: 3 } } }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: INBOX_STATE_KEY }));
    expect(getInboxSnapshot().chats.b?.settledAt).toBe(3);
    expect(getInboxSnapshot().chats.a).toBeUndefined();

    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage down");
    });
    expect(() => settleChats(["c"], 8)).not.toThrow();
    expect(getInboxSnapshot().chats.c?.settledAt).toBe(8);
  });

  it("keeps both chats when the document changes between read and write", () => {
    const foreign = JSON.stringify({
      rev: 1,
      chats: { b: { touch: 8, snoozeAt: 8, snoozeUntil: 80 } },
    });
    let stored: string | null = null;
    let reads = 0;
    vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
      if (key !== INBOX_STATE_KEY) return null;
      reads += 1;
      if (reads === 1) return null;
      return stored ?? foreign;
    });
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === INBOX_STATE_KEY) stored = String(value);
    });
    settleChats(["a"], 9);
    const doc = JSON.parse(stored ?? "{}") as { chats: Record<string, { settledAt?: number; snoozeUntil?: number }> };
    expect(doc.chats.a?.settledAt).toBe(9);
    expect(doc.chats.b?.snoozeUntil).toBe(80);
  });

  it("keeps the change in memory when the write is rejected, then saves it on the next try", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => settleChats(["a"], 6)).not.toThrow();
    expect(getInboxSnapshot().chats.a?.settledAt).toBe(6);
    expect(localStorage.getItem(INBOX_STATE_KEY)).toBeNull();
    vi.restoreAllMocks();
    settleChats(["b"], 7);
    const saved = JSON.parse(localStorage.getItem(INBOX_STATE_KEY) ?? "{}") as {
      chats: Record<string, { settledAt?: number }>;
    };
    expect(saved.chats.a?.settledAt).toBe(6);
    expect(saved.chats.b?.settledAt).toBe(7);
  });

  it("does not archive a chat when it settles or unsnoozes", () => {
    settleChats(["a"], 1);
    unsnoozeChats(["a"], 2);
    expect(JSON.stringify(getInboxSnapshot())).not.toMatch(/archived|deleted|terminal/);
  });
});
