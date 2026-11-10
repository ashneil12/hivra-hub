import { describe, expect, it } from "vitest";
import { LARGE_PASTE_BYTES, isLargePaste } from "./largePaste";
import { inlineAfterUndo, type LargePasteUndo } from "./largePasteUndo";

const file = (id: string) => ({ id, name: `${id}.txt` });
const undo = (extra: Partial<LargePasteUndo> = {}): LargePasteUndo => ({
  attachmentId: "paste",
  text: "the log",
  ...extra,
});

describe("inlineAfterUndo", () => {
  it("puts the paste back when the draft is empty and drops only that file", () => {
    const next = inlineAfterUndo("", [file("other"), file("paste")], undo());
    expect(next.draft).toBe("the log");
    expect(next.attachments.map((item) => item.id)).toEqual(["other"]);
  });

  it("separates the paste from text already in the draft, and keeps a trailing newline as the separator", () => {
    expect(inlineAfterUndo("hello", [], undo()).draft).toBe("hello\nthe log");
    expect(inlineAfterUndo("hello\n", [], undo()).draft).toBe("hello\nthe log");
    expect(inlineAfterUndo("hello\r\n", [], undo({ text: "line\r\nmore" })).draft).toBe(
      "hello\r\nline\r\nmore",
    );
  });

  it("still inserts the text when the chip was already removed", () => {
    const next = inlineAfterUndo("kept", [file("other")], undo({ text: "back" }));
    expect(next.draft).toBe("kept\nback");
    expect(next.attachments.map((item) => item.id)).toEqual(["other"]);
  });

  it("does not add a blank line when the remembered text is empty", () => {
    const next = inlineAfterUndo("kept", [file("paste")], undo({ text: "" }));
    expect(next.draft).toBe("kept");
    expect(next.attachments).toEqual([]);
  });
});

describe("the large paste threshold", () => {
  it("stays 32 KiB of UTF-8, so undo does not change which pastes become files", () => {
    expect(LARGE_PASTE_BYTES).toBe(32 * 1024);
    const under = "a".repeat(LARGE_PASTE_BYTES - 1);
    const exact = "a".repeat(LARGE_PASTE_BYTES);
    expect(isLargePaste(under)).toBe(false);
    expect(isLargePaste(exact)).toBe(true);
    expect(isLargePaste("й".repeat(16_383))).toBe(false);
    expect(isLargePaste("й".repeat(16_384))).toBe(true);
  });
});
