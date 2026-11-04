// Translated from Raven raven/memory_engine/consolidate/consolidator.py
// _drop_bullets_without_src (Apache-2.0). The upstream file does not carry a
// separate copyright line. Licence: src/features/historyImport/vendor/raven-LICENSE.
//
// Raven keeps headings and blank lines, and only drops "- " bullets missing
// `[src: episodes.md @ YYYY-MM-DD H:MM]`. Hivra drops every line that does not
// cite a conversation and a message that was actually sent: the package says a
// line without a source is removed, and a made-up id is not a source.

import { findSecrets } from "../../portable/model/secrets";

const SRC = /\[src:\s+([A-Za-z0-9._:-]+)\s+#([A-Za-z0-9._:-]+)\]/g;

export type Citation = { conversationId: string; messageId: string };

export function citeKey(conversationId: string, messageId: string): string {
  return `${conversationId}#${messageId}`;
}

export function citationsIn(line: string): Citation[] {
  return [...line.matchAll(new RegExp(SRC))].map((match) => ({
    conversationId: match[1] ?? "",
    messageId: match[2] ?? "",
  }));
}

/**
 * Keep a line only when it cites a message that was sent and the line itself
 * is not a secret. Blank lines go too, so every remaining line has a source.
 */
export function dropLinesWithoutSource(
  body: string,
  allowed: ReadonlySet<string>,
): { text: string; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === "") {
      dropped += 1;
      continue;
    }
    const ok = citationsIn(line).some((cite) => allowed.has(citeKey(cite.conversationId, cite.messageId)));
    if (!ok || findSecrets(line).length > 0) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), dropped };
}
