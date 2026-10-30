/**
 * r94 (Critiquito g, c02 8ff9): asked "anything need me", the Lead said "Nothing needs you. No questions are waiting."
 * The second sentence says the first again. Where a reply renders, "Nothing needs you" stands alone; the doubled
 * sentence after it goes. Code fences are left alone.
 */
const DOUBLED =
  /\b(Nothing (?:needs|is waiting on|is waiting for) you(?: right now| now| yet| at the moment)?)([.!,;]|\s+[-–])\s*(?:and\s+)?(?:there are\s+)?no (?:open\s+|pending\s+)?(?:questions|decisions|approvals|asks)(?: or [a-z]+)?(?: (?:are|is))?(?: (?:waiting|pending|open|for you))*(?: on you| for you)?(?: right now| now| yet)?([.!]|(?=\n)|$)/gi;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

export function withoutDoubledAllClear(text: string): string {
  if (!text || !/nothing (?:needs|is waiting)/i.test(text)) return text;
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(DOUBLED, "$1.");
    })
    .join("\n");
}
