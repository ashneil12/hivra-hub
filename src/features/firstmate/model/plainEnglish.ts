// WP-41: plain-English endings, on unless the person switches them off. Vitest runs in node, where localStorage
// throws, so a save also sets an in-memory override the session instruction can read.
import { readFlag, writeFlag } from "../../settings/model/storageFlags";

export const PLAIN_ENGLISH_RULE =
  "Every reply that reports work or answers a question ends with one short plain-English paragraph saying what happened and what it means, with no jargon, lists or headings. Worker reports end the same way, and first mates pass that paragraph through to Ash.";

export const PLAIN_ENGLISH_KEY = "monocode.plainEnglishEndings";

let override: boolean | undefined;

/** On when nothing has been saved. */
export function plainEnglishEndings(): boolean {
  if (override !== undefined) return override;
  return readFlag(PLAIN_ENGLISH_KEY) ?? true;
}

export function savePlainEnglishEndings(on: boolean): void {
  override = on;
  writeFlag(PLAIN_ENGLISH_KEY, on);
}

/** Test-only. */
export function __resetPlainEnglishForTests(): void {
  override = undefined;
}
