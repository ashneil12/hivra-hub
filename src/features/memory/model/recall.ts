// WP-51: relevant memory goes inside the turn, fenced as untrusted. The system prompt is not touched.

import { AGENT_ZERO_MEMORIES } from "../vendor/agentZeroMemories";
import { confidence, ftsMatch, type Belief } from "../vendor/mercuryBelief";
import { engineName, mentionsSecret, normalizeFact, type MemoryDoc, type MemoryItem } from "./doc";

export const RECALL_OPEN = "<untrusted_memory>";
export const RECALL_CLOSE = "</untrusted_memory>";

function beliefOf(item: MemoryItem): Belief {
  return {
    support: item.support,
    against: item.against,
    ownerStated: false,
    status: item.state === "unreviewed" ? "candidate" : "confirmed",
    lastSupportedAt: item.updatedAt,
    timescale: "stable",
    kind: "preference",
  };
}

/** "written by Codex", or nothing when the reader is that same engine or the writer is not known. */
function writtenBy(item: MemoryItem, readingEngine: string | undefined): string {
  if (!readingEngine || !item.by || item.by === readingEngine) return "";
  return ` (written by ${engineName(item.by)})`;
}

/**
 * The facts a query recalls for one mate, best first, at most eight. Confirmed and edited facts only. An unreviewed
 * fact is visible on the screen and nowhere else.
 */
export function recallItems(doc: MemoryDoc, mateId: string, query: string, now: number): MemoryItem[] {
  const match = ftsMatch(query);
  if (!match) return [];
  const terms = match.split(" OR ").map((term) => term.slice(1, -1));
  return doc.items
    .filter(
      (item) =>
        item.mateId === mateId &&
        item.action === "add" &&
        (item.state === "confirmed" || item.state === "edited") &&
        !mentionsSecret(item.text),
    )
    .map((item) => ({
      item,
      overlap: terms.filter((term) => normalizeFact(item.text).toLowerCase().includes(term)).length,
      score: confidence(beliefOf(item), now),
    }))
    .filter((row) => row.overlap > 0 && row.score >= 0.35)
    .sort((a, b) => b.overlap - a.overlap || b.item.updatedAt - a.item.updatedAt || b.score - a.score)
    .slice(0, 8)
    .map((row) => row.item);
}

/** The fence for a list of recalled facts, or undefined when there are none. */
export function recallFence(items: readonly MemoryItem[], readingEngine?: string): string | undefined {
  if (!items.length) return undefined;
  const lines = items.map((item) => {
    const text = item.text.split(RECALL_CLOSE).join("").split(RECALL_OPEN).join("");
    return `- ${new Date(item.updatedAt).toISOString()} ${text}${writtenBy(item, readingEngine)}`;
  });
  const body = AGENT_ZERO_MEMORIES.replace("{{memories}}", lines.join("\n"));
  return `${RECALL_OPEN}\n${body}\n${RECALL_CLOSE}`;
}

/** Confirmed and edited facts only. An unreviewed fact is visible on the screen and nowhere else. */
export function recallBlock(
  doc: MemoryDoc,
  mateId: string,
  query: string,
  now: number,
  readingEngine?: string,
): string | undefined {
  return recallFence(recallItems(doc, mateId, query, now), readingEngine);
}

/** The system string comes back unchanged. The fence is appended to the user message. */
export function recallIntoTurn(input: {
  system: string;
  message: string;
  doc: MemoryDoc;
  mateId: string;
  now?: number;
  /** WP-100: the engine about to read this turn; a fact another engine wrote says so. */
  readingEngine?: string;
}): { system: string; message: string } {
  const block = recallBlock(input.doc, input.mateId, input.message, input.now ?? 0, input.readingEngine);
  if (!block) return { system: input.system, message: input.message };
  return { system: input.system, message: `${input.message}\n\n${block}` };
}
