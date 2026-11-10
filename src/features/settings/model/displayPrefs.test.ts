// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_LIST_INBOX_KEY,
  loadChatListInbox,
  loadComposerAutocorrect,
  loadMaskEmails,
  loadShowRemainingUsage,
  saveChatListInbox,
  saveComposerAutocorrect,
  saveMaskEmails,
  saveShowRemainingUsage,
  subscribeChatListInbox,
  subscribeComposerAutocorrect,
  subscribeMaskEmails,
  subscribeShowRemainingUsage,
} from "./displayPrefs";

const prefs = [
  {
    name: "show remaining usage",
    key: "monocode.showRemainingUsage",
    defaultValue: false,
    load: loadShowRemainingUsage,
    save: saveShowRemainingUsage,
    subscribe: subscribeShowRemainingUsage,
  },
  {
    name: "mask emails",
    key: "monocode.maskEmails",
    defaultValue: true,
    load: loadMaskEmails,
    save: saveMaskEmails,
    subscribe: subscribeMaskEmails,
  },
  {
    name: "composer autocorrect",
    key: "monocode.composerAutocorrect",
    defaultValue: true,
    load: loadComposerAutocorrect,
    save: saveComposerAutocorrect,
    subscribe: subscribeComposerAutocorrect,
  },
  {
    name: "chat list inbox",
    key: CHAT_LIST_INBOX_KEY,
    defaultValue: false,
    load: loadChatListInbox,
    save: saveChatListInbox,
    subscribe: subscribeChatListInbox,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  prefs.forEach((pref) => pref.save(pref.defaultValue));
  localStorage.clear();
});

describe.each(prefs)("$name preference", (pref) => {
  it("uses its default and notifies this window when saved", () => {
    const listener = vi.fn();
    const unsubscribe = pref.subscribe(listener);
    expect(pref.load()).toBe(pref.defaultValue);

    const value = !pref.defaultValue;
    pref.save(value);

    expect(pref.load()).toBe(value);
    expect(localStorage.getItem(pref.key)).toBe(value ? "1" : "0");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps the saved value in memory when storage rejects the write", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const listener = vi.fn();
    const unsubscribe = pref.subscribe(listener);
    listener.mockImplementation(() => expect(pref.load()).toBe(true));

    pref.save(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(pref.load()).toBe(true);
    unsubscribe();
    pref.save(false);
    expect(pref.load()).toBe(false);
  });

  it("follows a change saved in another window", () => {
    const listener = vi.fn();
    const unsubscribe = pref.subscribe(listener);

    const value = !pref.defaultValue;
    localStorage.setItem(pref.key, value ? "1" : "0");
    window.dispatchEvent(new StorageEvent("storage", { key: pref.key }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pref.load()).toBe(value);

    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(listener).toHaveBeenCalledTimes(1);

    localStorage.removeItem(pref.key);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(pref.load()).toBe(pref.defaultValue);
    unsubscribe();
  });
});

describe("chat list inbox migration", () => {
  afterEach(() => {
    localStorage.removeItem(CHAT_LIST_INBOX_KEY);
  });

  it("reads a missing key as off", () => {
    localStorage.removeItem(CHAT_LIST_INBOX_KEY);
    expect(loadChatListInbox()).toBe(false);
  });

  it("reads old and invalid stored values as off", () => {
    for (const raw of ["", "0", "false", "yes", "on", "2", "true ", " TRUE"]) {
      localStorage.setItem(CHAT_LIST_INBOX_KEY, raw);
      expect(loadChatListInbox(), raw).toBe(false);
    }
  });

  it("reads only the saved on values as on", () => {
    localStorage.setItem(CHAT_LIST_INBOX_KEY, "1");
    expect(loadChatListInbox()).toBe(true);
    localStorage.setItem(CHAT_LIST_INBOX_KEY, "true");
    expect(loadChatListInbox()).toBe(true);
  });

  it("leaves other saved settings alone", () => {
    localStorage.setItem("monocode.maskEmails", "0");
    saveChatListInbox(true);
    expect(localStorage.getItem("monocode.maskEmails")).toBe("0");
    expect(localStorage.getItem(CHAT_LIST_INBOX_KEY)).toBe("1");
  });
});
