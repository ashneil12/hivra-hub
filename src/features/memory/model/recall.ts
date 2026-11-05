// WP-51: relevant memory goes inside the turn, fenced as untrusted. The system prompt is not touched.

import { AGENT_ZERO_MEMORIES } from "../vendor/agentZeroMemories";
import { confidence, ftsMatch, type Belief } from "../vendor/mercuryBelief";
import { mentionsSecret, normalizeFact, type MemoryDoc, type MemoryItem } from "./doc";

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

/** Confirmed and edited facts only. An unreviewed fact is visible on the screen and nowhere else. */
export function recallBlock(doc: MemoryDoc, mateId: string, query: string, now: number): string | undefined {
  const match = ftsMatch(query);
  if (!match) return undefined;
  const terms = match.split(" OR ").map((term) => term.slice(1, -1));
  const ranked = doc.items
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
    .sort((a, b) => b.overlap - a.overlap || b.item.updatedAt - a.item.updatedAt || b.score - a.score);
  if (!ranked.length) return undefined;
  const lines = ranked.slice(0, 8).map((row) => {
    const text = row.item.text.split(RECALL_CLOSE).join("").split(RECALL_OPEN).join("");
    return `- ${new Date(row.item.updatedAt).toISOString()} ${text}`;
  });
  const body = AGENT_ZERO_MEMORIES.replace("{{memories}}", lines.join("\n"));
  return `${RECALL_OPEN}\n${body}\n${RECALL_CLOSE}`;
}

/** The system string comes back unchanged. The fence is appended to the user message. */
export function recallIntoTurn(input: {
  system: string;
  message: string;
  doc: MemoryDoc;
  mateId: string;
  now?: number;
}): { system: string; message: string } {
  const block = recallBlock(input.doc, input.mateId, input.message, input.now ?? 0);
  if (!block) return { system: input.system, message: input.message };
  return { system: input.system, message: `${input.message}\n\n${block}` };
}
