import { describe, expect, it } from "vitest";
import type { Attachment } from "./session";
import {
  canRestoreStash,
  isStashShortcut,
  peekStash,
  restoreAttachments,
  STASH_STORAGE_KEY,
  stashDraft,
} from "./draftStash";

function memory(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

const file = (extra: Partial<Attachment> = {}): Attachment => ({
  id: "live",
  name: "notes.txt",
  mimeType: "text/plain",
  kind: "file",
  size: 4,
  data: "aGk=",
  previewUrl: "blob:gone",
  copyFromPath: true,
  ...extra,
});

describe("stashDraft", () => {
  it("saves text and attachments, and a new stash replaces the old one", () => {
    const box = memory();
    expect(stashDraft("chat", "hello\r\nthere", [file()], box, 10)).toEqual({ ok: true });
    expect(peekStash("chat", box)).toEqual({
      text: "hello\r\nthere",
      savedAt: 10,
      attachments: [
        { name: "notes.txt", mimeType: "text/plain", kind: "file", size: 4, data: "aGk=" },
      ],
    });
    expect(stashDraft("chat", "next", [], box, 11)).toEqual({ ok: true });
    expect(peekStash("chat", box)?.text).toBe("next");
    expect(peekStash("other", box)).toBeNull();
  });

  it("keeps a path with spaces, unicode and dots, and drops the preview URL", () => {
    const box = memory();
    stashDraft(
      "chat",
      "",
      [file({ name: "план.txt", path: "C:\\notes\\my file\\..\\план.txt", data: undefined })],
      box,
      1,
    );
    const stashed = peekStash("chat", box);
    expect(stashed?.attachments[0]).toEqual({
      name: "план.txt",
      mimeType: "text/plain",
      kind: "file",
      size: 4,
      path: "C:\\notes\\my file\\..\\план.txt",
    });
    expect(JSON.parse(box.getItem(STASH_STORAGE_KEY) ?? "{}").chat.attachments[0].previewUrl).toBeUndefined();
  });

  it("refuses an empty draft and does not replace a saved one", () => {
    const box = memory();
    stashDraft("chat", "keep", [], box, 1);
    expect(stashDraft("chat", "  \n", [], box, 2)).toEqual({ ok: false, reason: "empty" });
    expect(peekStash("chat", box)?.text).toBe("keep");
  });

  it("leaves the previous draft in place when saving throws", () => {
    const box = memory();
    stashDraft("chat", "keep", [], box, 1);
    const failing: Storage = {
      ...box,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(stashDraft("chat", "new", [file()], failing, 2)).toEqual({ ok: false, reason: "save" });
    expect(peekStash("chat", box)?.text).toBe("keep");
  });

  it("drops a corrupt, partial or hostile record", () => {
    const box = memory();
    box.setItem(STASH_STORAGE_KEY, "{");
    expect(peekStash("chat", box)).toBeNull();
    box.setItem(
      STASH_STORAGE_KEY,
      JSON.stringify({
        chat: { text: "ok", savedAt: 1, attachments: [{ name: "x", mimeType: "text/plain", kind: "nope", size: 1 }] },
        "": { text: "no", savedAt: 1, attachments: [] },
        __proto__: { text: "no", savedAt: 1, attachments: [] },
      }),
    );
    expect(peekStash("chat", box)).toBeNull();
    expect(peekStash("", box)).toBeNull();
  });
});

describe("restore", () => {
  it("refuses to replace text or attachments that are already there", () => {
    expect(canRestoreStash("", [])).toBe(true);
    expect(canRestoreStash("  ", [])).toBe(true);
    expect(canRestoreStash("typed", [])).toBe(false);
    expect(canRestoreStash("", [{ id: "a" }])).toBe(false);
  });

  it("gives restored attachments new ids and keeps their bytes", () => {
    const box = memory();
    stashDraft("chat", "hello", [file(), file({ name: "second.txt", data: "Yg==" })], box, 5);
    const draft = peekStash("chat", box)!;
    const files = restoreAttachments(draft);
    expect(files.map((item) => item.id)).toEqual(["stash-5-0", "stash-5-1"]);
    expect(files[0].data).toBe("aGk=");
    expect(files[0].previewUrl).toBeUndefined();
    expect(files[1].name).toBe("second.txt");
    expect(peekStash("chat", box)?.text).toBe("hello");
  });
});

describe("isStashShortcut", () => {
  it("matches Cmd or Ctrl Shift S, including a layout whose S key types another character", () => {
    expect(isStashShortcut({ key: "s", code: "KeyS", metaKey: true, shiftKey: true })).toBe(true);
    expect(isStashShortcut({ key: "ы", code: "KeyS", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isStashShortcut({ key: "s", metaKey: true, shiftKey: true, altKey: true })).toBe(false);
    expect(isStashShortcut({ key: "s", metaKey: true })).toBe(false);
    expect(isStashShortcut({ key: "r", code: "KeyR", metaKey: true, shiftKey: true })).toBe(false);
  });
});
