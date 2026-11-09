// Hidden characters let a model read instructions the person reviewing the prompt cannot see. T3 Code's
// sanitizeLinkedPrompt (packages/shared/src/promptLinks.ts, MIT, Copyright (c) 2026 T3 Tools Inc.) holds the pattern;
// this file translates just that sanitiser (the URL parts of that file are not copied). A hidden character is removed,
// never replaced; an emoji's own joiners and presentation selectors stay where they belong.

/**
 * Control characters, bidi controls, zero-width and formatting characters, text-style variation selectors VS1 to
 * VS14 (VS15 and VS16 stay: they pick a glyph's presentation) and the Unicode tag block, which spells whole words
 * invisibly. Written as escapes so the source stays readable.
 */
const HIDDEN = new RegExp(
  "[" +
    "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C" +
    "\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B\\u200C\\u200E\\u200F\\u202A-\\u202E" +
    "\\u2060-\\u206F\\u3164\\uFE00-\\uFE0D\\uFEFF\\uFFA0\\uFFF0-\\uFFFB" +
    "\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E0FFF}" +
    "]",
  "gu",
);

/** A zero-width joiner and the emoji presentation selector. */
const ZERO_WIDTH_JOINER = "‍";
const VARIATION_SELECTOR_16 = 0xfe0f;

/** U+2028 and U+2029 are line breaks to a person, whatever the platform does with them. */
const LINE_BREAKS = new RegExp("[\\r\\u2028\\u2029]\\n?", "g");

/** Numeric ranges rather than Unicode property escapes, as the original does. */
const isEmojiPart = (codePoint: number | undefined): boolean =>
  codePoint !== undefined &&
  ((codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2190 && codePoint <= 0x2bff) ||
    codePoint === VARIATION_SELECTOR_16);

export type StrippedText = {
  /** The visible text, with line endings normalised and surrounding whitespace trimmed. */
  text: string;
  /** How many hidden characters were removed. */
  removed: number;
};

/**
 * The visible text of a message, and how many hidden characters it carried.
 *
 * A zero-width joiner is kept only between two emoji (a family, a flag), where it draws one glyph; anywhere else it
 * hides text. A message holding nothing but hidden characters comes back empty.
 */
export function stripHiddenText(raw: string): StrippedText {
  const { text, removed } = stripHiddenCharacters(raw);
  return { text: text.trim(), removed };
}

/** The same removal without touching whitespace, for pasting into a draft mid-sentence. */
export function stripHiddenCharacters(raw: string): StrippedText {
  let removed = 0;
  const visible = Array.from(
    raw
      .replace(LINE_BREAKS, "\n")
      .replace(HIDDEN, () => {
        removed++;
        return "";
      }),
  );
  const text = visible
    .filter((character, index) => {
      if (character !== ZERO_WIDTH_JOINER) return true;
      const kept =
        isEmojiPart(visible[index - 1]?.codePointAt(0)) &&
        isEmojiPart(visible[index + 1]?.codePointAt(0));
      if (!kept) removed++;
      return kept;
    })
    .join("");
  return { text, removed };
}
