// WP-51: relevant memory goes inside the turn, fenced as untrusted. The system prompt is not touched.
// WP-99: which memories are relevant, and why, is decided by recallPolicy.

import { AGENT_ZERO_MEMORIES } from "../vendor/agentZeroMemories";
import type { MemoryDoc } from "./doc";
import { recallDecision, type RecallDecisionInput } from "./recallPolicy";

export const RECALL_OPEN = "<untrusted_memory>";
export const RECALL_CLOSE = "</untrusted_memory>";

/** The fence, or undefined when the policy picked nothing. */
export function recallFence(doc: MemoryDoc, picked: readonly string[]): string | undefined {
  return fenceFor(doc, picked);
}

function fenceFor(doc: MemoryDoc, picked: readonly string[]): string | undefined {
  if (!picked.length) return undefined;
  const byId = new Map(doc.items.map((item) => [item.id, item]));
  const lines = picked.flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    const text = item.text.split(RECALL_CLOSE).join("").split(RECALL_OPEN).join("");
    return [`- ${new Date(item.updatedAt).toISOString()} ${text}`];
  });
  if (!lines.length) return undefined;
  const body = AGENT_ZERO_MEMORIES.replace("{{memories}}", lines.join("\n"));
  return `${RECALL_OPEN}\n${body}\n${RECALL_CLOSE}`;
}

/**
 * The decision and the block for one Mono and one search.
 *
 * `recallBlock` is a search the Mono asked for by name, so it runs explicit: no gates, no score
 * floor. The per-turn recall inside App runs automatic: the policy's gates and margin rule apply.
 */
export function recallBlock(doc: MemoryDoc, mateId: string, query: string, now: number): string | undefined {
  return recallBlockWithTrace(doc, mateId, query, now).block;
}

export function recallBlockWithTrace(
  doc: MemoryDoc,
  mateId: string,
  query: string,
  now: number,
): { block?: string; decision: ReturnType<typeof recallDecision> } {
  const decision = recallDecision({ doc, mateId, message: query, now, mode: "explicit" });
  return { block: fenceFor(doc, decision.picked), decision };
}

/** The system string comes back unchanged. The fence is appended to the user message. */
export function recallIntoTurn(input: {
  system: string;
  message: string;
  doc: MemoryDoc;
  mateId: string;
  now?: number;
  /** WP-99: earlier messages, the ids already shown, and whether a person asked for this search. */
  recent?: readonly string[];
  exclude?: ReadonlySet<string>;
  mode?: RecallDecisionInput["mode"];
}): { system: string; message: string } {
  const block = recallTurnBlock(input);
  if (!block) return { system: input.system, message: input.message };
  return { system: input.system, message: `${input.message}\n\n${block}` };
}

export function recallTurnBlock(input: {
  message: string;
  doc: MemoryDoc;
  mateId: string;
  now?: number;
  recent?: readonly string[];
  exclude?: ReadonlySet<string>;
  mode?: RecallDecisionInput["mode"];
}): string | undefined {
  const decision = recallDecision({
    doc: input.doc,
    mateId: input.mateId,
    message: input.message,
    recent: input.recent,
    now: input.now ?? 0,
    mode: input.mode ?? "automatic",
    exclude: input.exclude,
  });
  return fenceFor(input.doc, decision.picked);
}
