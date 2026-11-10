import { describe, expect, it } from "vitest";
import {
  LARGE_PASTE_BYTES,
  isLargePaste,
  isPasteKey,
  largePasteContents,
  largePasteFileName,
  pastesInline,
} from "./largePaste";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("isLargePaste", () => {
  it("measures bytes, not characters", () => {
    // 20,000 ASCII characters are one byte each: under the line.
    const ascii = "a".repeat(20_000);
    expect(bytes(ascii)).toBe(20_000);
    expect(isLargePaste(ascii)).toBe(false);
    // 20,000 emoji are 4 bytes each: well over.
    const emoji = "🐙".repeat(20_000);
    expect(bytes(emoji)).toBe(80_000);
    expect(isLargePaste(emoji)).toBe(true);
  });

  it("is over at exactly the threshold and under just below it", () => {
    expect(isLargePaste("a".repeat(LARGE_PASTE_BYTES))).toBe(true);
    expect(isLargePaste("a".repeat(LARGE_PASTE_BYTES - 1))).toBe(false);
  });

  it("counts a multi-byte script by its bytes", () => {
    // A 10,952-character CJK string is over 32,768 bytes at 3 bytes each.
    expect(isLargePaste("漢".repeat(10_952))).toBe(true);
    expect(isLargePaste("漢".repeat(10_000))).toBe(false);
  });

  it("treats an empty paste as small", () => {
    expect(isLargePaste("")).toBe(false);
  });
});

describe("isPasteKey", () => {
  it("reads the physical key first, so a non-Latin layout still counts", () => {
    expect(isPasteKey({ key: "М", code: "KeyV" })).toBe(true);
    expect(isPasteKey({ key: "v" })).toBe(true);
    expect(isPasteKey({ key: "V" })).toBe(true);
    expect(isPasteKey({ key: "с", code: "KeyC" })).toBe(false);
  });
});

describe("pastesInline", () => {
  it("is false by default and true only with the shift key on the paste shortcut", () => {
    expect(pastesInline({})).toBe(false);
    expect(pastesInline({ metaKey: true })).toBe(false);
    expect(pastesInline({ ctrlKey: true })).toBe(false);
    expect(pastesInline({ metaKey: true, shiftKey: true })).toBe(true);
    expect(pastesInline({ ctrlKey: true, shiftKey: true })).toBe(true);
  });

  it("reads the physical key, so a non-Latin layout still pastes inline", () => {
    // A Cyrillic layout reports "М" for the physical V key; e.code stays "KeyV".
    expect(pastesInline({ key: "М", code: "KeyV", metaKey: true, shiftKey: true })).toBe(
      true,
    );
    expect(pastesInline({ code: "KeyV", ctrlKey: true, shiftKey: true })).toBe(true);
    // The physical key must really be V, or any shortcut would count.
    expect(pastesInline({ code: "KeyC", metaKey: true, shiftKey: true })).toBe(false);
  });
});

describe("largePasteFileName", () => {
  it("names the file by the pasted text's first words", () => {
    expect(largePasteFileName("Vite config notes: the server port moved to 1430")).toBe(
      "Vite config notes.txt",
    );
  });

  it("skips leading punctuation and markup", () => {
    expect(largePasteFileName("---\n## Heading of the document")).toBe(
      "Heading of the document.txt",
    );
  });

  it("keeps a non-Latin name intact", () => {
    expect(largePasteFileName("東京の会議の議事録です")).toBe(
      "東京の会議の議事録です.txt",
    );
  });

  it("falls back when there are no words to name it by", () => {
    expect(largePasteFileName("   \n\t ")).toBe("Pasted text.txt");
    expect(largePasteFileName("???!!!")).toBe("Pasted text.txt");
  });

  it("caps the name so a long first line stays a filename", () => {
    const name = largePasteFileName("alpha ".repeat(40));
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith(".txt")).toBe(true);
  });

  it("never leaves characters a file path cannot hold", () => {
    expect(largePasteFileName('Report: "Q3/final" <draft> | v2?')).toBe(
      "Report Q3 final draft v2.txt",
    );
  });

  it("does not end a name in a dot or a space", () => {
    expect(largePasteFileName("done.")).toBe("done.txt");
  });
});

describe("largePasteContents", () => {
  it("writes the pasted bytes unchanged, as text", () => {
    const text = "line one\r\nline two\r\n";
    const file = largePasteContents(text);
    expect(file.name).toBe("line one.txt");
    expect(file.type).toBe("text/plain");
    expect(file.size).toBe(bytes(text));
  });

  it("gives an emoji paste a real byte size", () => {
    const text = "🐙".repeat(20_000);
    expect(largePasteContents(text).size).toBe(80_000);
  });
});
