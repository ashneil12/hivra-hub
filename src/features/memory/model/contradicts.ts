// WP-111: two facts contradict only when the same subject ends in one exclusive value, or one side
// negates the same words. Anything less sure is not a contradiction.

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["npm", "pnpm"],
  ["npm", "yarn"],
  ["npm", "bun"],
  ["pnpm", "yarn"],
  ["pnpm", "bun"],
  ["yarn", "bun"],
  ["yes", "no"],
  ["true", "false"],
  ["on", "off"],
];

const EXCLUSIVE = new Set(PAIRS.flat());

/** Dummy auxiliaries that only exist to carry "not". "is" and "can" stay, because they are the verb. */
const DROP_WITH_NOT = new Set(["does", "do", "did"]);

function tokens(text: string): string[] {
  const expanded = text
    .toLowerCase()
    .replace(/won't/g, "will not")
    .replace(/can't/g, "can not")
    .replace(/cannot/g, "can not")
    .replace(/n't/g, " not");
  return expanded
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 0);
}

function exclusive(left: string, right: string): boolean {
  return PAIRS.some((pair) => (pair[0] === left && pair[1] === right) || (pair[0] === right && pair[1] === left));
}

function sameWord(left: string, right: string): boolean {
  if (left === right) return true;
  if (EXCLUSIVE.has(left) || EXCLUSIVE.has(right)) return false;
  return left + "s" === right || right + "s" === left;
}

/** Removes the first negation and says whether there was one. "no" is a value, not a negation. */
function stripNegation(words: string[]): { negated: boolean; words: string[] } {
  const notAt = words.indexOf("not");
  const neverAt = words.indexOf("never");
  const at = notAt === -1 ? neverAt : neverAt === -1 ? notAt : Math.min(notAt, neverAt);
  if (at === -1) return { negated: false, words };
  const next = words.slice();
  next.splice(at, 1);
  if (words[at] === "not" && at > 0 && DROP_WITH_NOT.has(words[at - 1])) next.splice(at - 1, 1);
  return { negated: true, words: next };
}

function sameWords(left: string[], right: string[]): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  return left.every((word, index) => sameWord(word, right[index]));
}

function exclusiveSuffix(left: string[], right: string[]): boolean {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && sameWord(left[prefix], right[prefix])) prefix += 1;
  if (prefix < 1) return false;
  const restLeft = left.slice(prefix);
  const restRight = right.slice(prefix);
  if (restLeft.length === 0 || restLeft.length !== restRight.length) return false;
  let diffs = 0;
  for (let index = 0; index < restLeft.length; index += 1) {
    if (restLeft[index] === restRight[index]) continue;
    if (!exclusive(restLeft[index], restRight[index])) return false;
    diffs += 1;
  }
  return diffs === 1;
}

/** True only when the two facts clearly disagree. Unsure means false. */
export function contradicts(left: string, right: string): boolean {
  const a = tokens(left);
  const b = tokens(right);
  if (a.length === 0 || b.length === 0) return false;
  const strippedLeft = stripNegation(a);
  const strippedRight = stripNegation(b);
  if (strippedLeft.negated !== strippedRight.negated) {
    return sameWords(strippedLeft.words, strippedRight.words);
  }
  if (strippedLeft.negated) return false;
  return exclusiveSuffix(a, b);
}
