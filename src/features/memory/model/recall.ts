// WP-51: relevant memory goes inside the turn, fenced as untrusted. The system prompt is not touched.
// WP-99: which memories are relevant, and why, is decided by recallPolicy.

import { AGENT_ZERO_MEMORIES } from "../vendor/agentZeroMemories";
import { engineName, type MemoryDoc, type MemoryItem } from "./doc";
import { givesOrders, ORDER_NOTE } from "./orderScan";
import { recallDecision, type RecallDecisionInput } from "./recallPolicy";

export const RECALL_OPEN = "<untrusted_memory>";
export const RECALL_CLOSE = "</untrusted_memory>";

/** "written by Codex", or nothing when the reader is that same engine or the writer is not known (WP-100). */
function writtenBy(item: MemoryItem, readingEngine: string | undefined): string {
  if (!readingEngine || !item.by || item.by === readingEngine) return "";
  return ` (written by ${engineName(item.by)})`;
}

/** The fence, or undefined when the policy picked nothing. */
export function recallFence(doc: MemoryDoc, picked: readonly string[], readingEngine?: string): string | undefined {
  return fenceFor(doc, picked, readingEngine);
}

function fenceFor(doc: MemoryDoc, picked: readonly string[], readingEngine?: string): string | undefined {
  // WP-148: a memory this turn did not pick is not named. There is no index of the ones left out.
  if (!picked.length) return undefined;
  const byId = new Map(doc.items.map((item) => [item.id, item]));
  const lines = picked.flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    const text = item.text.split(RECALL_CLOSE).join("").split(RECALL_OPEN).join("");
    // WP-111: a memory that looks like instructions stays, with a note that it is data.
    const orders = givesOrders(item.text) ? ` ${ORDER_NOTE}` : "";
    return [`- ${new Date(item.updatedAt).toISOString()} ${text}${writtenBy(item, readingEngine)}${orders}`];
  });
  if (!lines.length) return undefined;
  const body = AGENT_ZERO_MEMORIES.replace("{{memories}}", lines.join("\n"));
  return `${RECALL_OPEN}\n${body}\n${RECALL_CLOSE}`;
}

/**
 * The fence for one Mono and one search the Mono asked for by name: no gates and no score floor.
 * The per-turn recall inside App calls recallTurnBlock, which runs automatic instead.
 */
export function recallBlock(
  doc: MemoryDoc,
  mateId: string,
  query: string,
  now: number,
  readingEngine?: string,
): string | undefined {
  const decision = recallDecision({ doc, mateId, message: query, now, mode: "explicit" });
  return fenceFor(doc, decision.picked, readingEngine);
}

/**
 * The memories a search a Mono asked for by name picks for one Mono, in the policy's order. The same decision
 * `recallBlock` fences; the Mono's memory tool uses it to count what was read as a use (WP-100).
 */
export function recallItems(doc: MemoryDoc, mateId: string, query: string, now: number): MemoryItem[] {
  const decision = recallDecision({ doc, mateId, message: query, now, mode: "explicit" });
  const byId = new Map(doc.items.map((item) => [item.id, item]));
  return decision.picked.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
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
  /** WP-100: the engine about to read this turn; a fact another engine wrote says so. */
  readingEngine?: string;
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
  readingEngine?: string;
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
  return fenceFor(input.doc, decision.picked, input.readingEngine);
}
