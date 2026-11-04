// WP-41: plain-English endings, on unless the person switches them off. The stored flag is read on every call, so
// another window's change wins. Vitest runs in node, where localStorage throws; a save then remembers the value
// only until storage can be read.
import { readFlag, writeFlag } from "../../settings/model/storageFlags";

export const PLAIN_ENGLISH_RULE =
  "Every reply that reports work or answers a question ends with one short plain-English paragraph saying what happened and what it means, with no jargon, lists or headings. Worker reports end the same way, and first mates pass that paragraph through to the person.";

export const PLAIN_ENGLISH_KEY = "monocode.plainEnglishEndings";

let fallback: boolean | undefined;

/** On when nothing has been saved. A stored value always wins over a save this window could not write. */
export function plainEnglishEndings(): boolean {
  const stored = readFlag(PLAIN_ENGLISH_KEY);
  if (stored !== null) return stored;
  return fallback ?? true;
}

export function savePlainEnglishEndings(on: boolean): void {
  writeFlag(PLAIN_ENGLISH_KEY, on);
  fallback = readFlag(PLAIN_ENGLISH_KEY) === null ? on : undefined;
}

/** Test-only. */
export function __resetPlainEnglishForTests(): void {
  fallback = undefined;
  try {
    localStorage.removeItem(PLAIN_ENGLISH_KEY);
  } catch {
    // node, or storage that refuses
  }
}
