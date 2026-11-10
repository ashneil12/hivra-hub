// Hidden characters let a model read instructions the person reviewing the prompt cannot see. T3 Code's
// sanitizeLinkedPrompt (packages/shared/src/promptLinks.ts, MIT, Copyright (c) 2026 T3 Tools Inc.) holds the pattern;
// this file translates just that sanitiser (the URL parts of that file are not copied). A hidden character is removed,
// never replaced; an emoji's own joiners and presentation selectors stay where they belong.

/**
 * Always hidden: control characters, bidi controls, zero-width and formatting characters. The characters real
 * writing needs (joiners, variation selectors, the tag characters of a flag) are judged in context below.
 * Written as escapes so the source stays readable.
 */
const ALWAYS_HIDDEN = new RegExp(
  "[" +
    "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C" +
    "\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B\\u200E\\u200F\\u202A-\\u202E" +
    "\\u2060-\\u206F\\u3164\\uFEFF\\uFFA0\\uFFF0-\\uFFFB" +
    "\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}" +
    "]",
  "u",
);

const ZERO_WIDTH_NON_JOINER = 0x200c;
const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_15 = 0xfe0e;
const VARIATION_SELECTOR_16 = 0xfe0f;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
/** The longest region flag is five tag letters or digits (gbeng); a little room, no more. */
const MAX_FLAG_TAGS = 8;

/** U+2028 and U+2029 are line breaks to a person, whatever the platform does with them. */
const LINE_BREAKS = new RegExp("[\\r\\u2028\\u2029]\\n?", "g");

/** A letter or mark of a script that needs joiners; Latin does not, so a joiner inside Latin text hides something. */
const JOINING_LETTER = /^(?![\p{Script=Latin}])[\p{L}\p{M}]$/u;
const HAN = /\p{Script=Han}/u;
const EMOJI = /\p{Emoji}/u;

const isVariationSelector = (cp: number): boolean =>
  (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const isFlagTag = (cp: number): boolean =>
  (cp >= 0xe0030 && cp <= 0xe0039) || (cp >= 0xe0061 && cp <= 0xe007a);
const isTagBlock = (cp: number): boolean => cp >= 0xe0000 && cp <= 0xe0fff;

const matches = (pattern: RegExp, cp: number | undefined): boolean =>
  cp !== undefined && pattern.test(String.fromCodePoint(cp));

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
 * Joiners, variation selectors and flag tags are kept only where real writing uses them: a joiner between two letters of a joining script
 * (Persian, Indic) or two emoji (a family), a variation selector after the character it styles (an emoji, a CJK
 * ideograph), and the tag sequence that follows a black flag and ends in a cancel tag (the England flag). Anywhere
 * else they hide text. A message holding nothing but hidden characters comes back empty.
 */
export function stripHiddenText(raw: string): StrippedText {
  const { text, removed } = stripHiddenCharacters(raw);
  return { text: text.trim(), removed };
}

/** The same removal without touching whitespace, for pasting into a draft mid-sentence. */
export function stripHiddenCharacters(raw: string): StrippedText {
  const input = Array.from(raw.replace(LINE_BREAKS, "\n"));
  const codes = input.map((character) => character.codePointAt(0) as number);
  const keep = new Array<boolean>(input.length).fill(true);

  // A well-formed flag: black flag, 1 to MAX_FLAG_TAGS tag letters or digits, then the cancel tag.
  for (let index = 0; index < codes.length; index++) {
    if (codes[index] !== BLACK_FLAG) continue;
    let end = index + 1;
    while (end < codes.length && isFlagTag(codes[end])) end++;
    const length = end - index - 1;
    if (length >= 1 && length <= MAX_FLAG_TAGS && codes[end] === CANCEL_TAG) {
      for (let tag = index + 1; tag <= end; tag++) codes[tag] = -codes[tag];
    }
  }

  let removed = 0;
  codes.forEach((signed, index) => {
    const flagTag = signed < 0;
    const cp = Math.abs(signed);
    const previous = Math.abs(codes[index - 1] ?? 0) || undefined;
    const next = Math.abs(codes[index + 1] ?? 0) || undefined;
    let visible = true;
    if (flagTag) visible = true;
    else if (isTagBlock(cp) && !isVariationSelector(cp)) visible = false;
    else if (cp === ZERO_WIDTH_NON_JOINER)
      visible = matches(JOINING_LETTER, previous) && matches(JOINING_LETTER, next);
    else if (cp === ZERO_WIDTH_JOINER)
      visible =
        (matches(JOINING_LETTER, previous) && matches(JOINING_LETTER, next)) ||
        (isEmojiPart(previous) && isEmojiPart(next));
    else if (isVariationSelector(cp))
      visible =
        cp === VARIATION_SELECTOR_15 || cp === VARIATION_SELECTOR_16
          ? isEmojiPart(previous) || matches(EMOJI, previous)
          : matches(HAN, previous);
    else visible = !ALWAYS_HIDDEN.test(input[index]);
    if (!visible) removed++;
    keep[index] = visible;
  });
  return { text: input.filter((_, index) => keep[index]).join(""), removed };
}
