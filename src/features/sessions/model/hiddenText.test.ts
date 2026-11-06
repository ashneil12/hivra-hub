import { describe, expect, it } from "vitest";
import { stripHiddenText } from "./hiddenText";

describe("stripHiddenText", () => {
  it("removes a message that is nothing but hidden characters", () => {
    expect(stripHiddenText("​‌⁠﻿")).toEqual({
      text: "",
      removed: 4,
    });
    // The Unicode tag block (U+E0000 to U+E0FFF) spells words an English
    // reader never sees.
    const tagged = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e, 0xe006f);
    expect(stripHiddenText(tagged)).toEqual({ text: "", removed: 4 });
  });

  it("removes bidi controls, zero-width joiners and control characters from mixed text", () => {
    const mixed = "Hello​ world‮⁦ there\u0007";
    expect(stripHiddenText(mixed)).toEqual({ text: "Hello world there", removed: 4 });
  });

  it("keeps an emoji's zero-width joiner where it belongs", () => {
    const heart = "❤️"; // red heart with VS16
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // family, joined
    const wave = "\u{1F44B}\u{1F3FD}"; // waving hand with skin tone
    expect(stripHiddenText(`love ${heart} and ${family} ${wave}`)).toEqual({
      text: `love ${heart} and ${family} ${wave}`,
      removed: 0,
    });
  });

  it("keeps VS16 after any emoji, and drops the text-style selectors T3 drops", () => {
    // T3's pattern removes VS1 to VS14 and leaves VS16 (the emoji presentation
    // selector) alone, wherever it sits.
    expect(stripHiddenText("❤️")).toEqual({ text: "❤️", removed: 0 });
    expect(stripHiddenText("\u{1F600}️")).toEqual({ text: "\u{1F600}️", removed: 0 });
    expect(stripHiddenText("abc︀")).toEqual({ text: "abc", removed: 1 });
  });

  it("removes a zero-width joiner that is not between two emoji", () => {
    expect(stripHiddenText("a‍b")).toEqual({ text: "ab", removed: 1 });
    // A joiner with an emoji on one side only is still a hidden character.
    expect(stripHiddenText("‍\u{1F600}")).toEqual({
      text: "\u{1F600}",
      removed: 1,
    });
  });

  it("removes a stray text-style variation selector", () => {
    expect(stripHiddenText("abc︀")).toEqual({ text: "abc", removed: 1 });
    expect(stripHiddenText("︀")).toEqual({ text: "", removed: 1 });
  });

  it("leaves ordinary text, accents and scripts alone", () => {
    const text = "Hello, world. Ça va? 你好 مرحبا 🎉";
    expect(stripHiddenText(text)).toEqual({ text, removed: 0 });
  });

  it("normalises line endings so the visible text is what a person sees", () => {
    expect(stripHiddenText("one\r\ntwo\rthree\nfour")).toEqual({
      text: "one\ntwo\nthree\nfour",
      removed: 0,
    });
  });

  it("trims surrounding whitespace but counts only hidden characters removed", () => {
    expect(stripHiddenText("  padded  ")).toEqual({ text: "padded", removed: 0 });
  });

  it("counts every hidden character it removes, not the runs", () => {
    const hidden = "​‌‍‎‏‪‫‬‭‮";
    expect(stripHiddenText(hidden).removed).toBe(10);
  });

  it("handles an empty string", () => {
    expect(stripHiddenText("")).toEqual({ text: "", removed: 0 });
  });
});
