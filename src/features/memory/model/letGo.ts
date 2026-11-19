// WP-240: the "Let go" list. A fact that is replaced, repeated, out of date or set aside by the person is kept here
// with the reason, instead of being lost. Nothing on this list is recalled, asked about or counted: every reader of
// `doc.items` already leaves it out, because it lives in `doc.archived`. "Bring back" puts one back; Delete is still the
// hard forget, and leaves the same digest a delete from the kept list leaves.
// (Idea: Nod by n8n, Apache-2.0, src/server/memory-tree.ts `archive` and its archived reasons. No code copied.)

import { ARCHIVE_CAP, bump, memoryId, withForgotten, type LetGoReason, type MemoryDoc, type MemoryItem } from "./doc";

/** The words a person reads for each reason. */
export const LET_GO_LABEL: Record<LetGoReason, string> = {
  superseded: "Replaced by a newer fact",
  duplicate: "Said the same as another fact",
  expired: "Its end date has passed",
  stale: "Mentioned once and not since",
  contradicted: "A newer message said otherwise",
  manual: "You let it go",
};

/** WP-240: how sure memory is, in the three words the Memory screen shows. */
export type MemoryStatus = "Mentioned once" | "Learned" | "Confirmed";

/**
 * Confirmed: the person accepted or edited it. Learned: two different messages said it. Mentioned once: one did.
 * `support` already counts distinct messages (a repeat adds to it instead of making a new row), so there is no new
 * counter.
 */
export function memoryStatus(item: Pick<MemoryItem, "state" | "support">): MemoryStatus {
  if (item.state === "confirmed" || item.state === "edited") return "Confirmed";
  return item.support >= 2 ? "Learned" : "Mentioned once";
}

/** An item as it goes onto the list. A copy with another id when the kept row stays (its text was replaced). */
export function letGoCopy(item: MemoryItem, reason: LetGoReason, at: number, by?: string, newId = false): MemoryItem {
  const copy: MemoryItem = { ...item };
  delete copy.dispute;
  delete copy.essential;
  if (newId) copy.id = memoryId([item.mateId, "let-go", item.id, item.text.toLowerCase()]);
  copy.letGo = by ? { reason, by, at } : { reason, at };
  return copy;
}

/** The list with these items on the end. One already there is replaced; past the cap the oldest go first. */
export function withArchived(doc: MemoryDoc, items: readonly MemoryItem[]): MemoryDoc {
  if (!items.length) return doc;
  const ids = new Set(items.map((item) => item.id));
  const kept = (doc.archived ?? []).filter((item) => !ids.has(item.id));
  const archived = [...kept, ...items]
    .sort((a, b) => (a.letGo?.at ?? 0) - (b.letGo?.at ?? 0))
    .slice(-ARCHIVE_CAP);
  return { ...doc, archived };
}

function withoutArchived(doc: MemoryDoc, id: string): MemoryDoc {
  const archived = (doc.archived ?? []).filter((item) => item.id !== id);
  const next: MemoryDoc = { ...doc, archived };
  if (!archived.length) delete next.archived;
  return next;
}

/**
 * Moves one kept fact onto the list. A parked clash is settled first (its own three choices); a skill is deleted, so
 * its lesson file is cleared too; and a proposal to change another fact is rejected rather than let go.
 */
export function letGoItem(doc: MemoryDoc, id: string, reason: LetGoReason, at: number, by?: string): MemoryDoc {
  const item = doc.items.find((have) => have.id === id);
  if (!item || item.dispute || item.action !== "add") return doc;
  const kept = { ...doc, items: doc.items.filter((have) => have.id !== id) };
  return bump(withArchived(kept, [letGoCopy(item, reason, at, by)]));
}

/** "Bring back": the item is kept again, as it was. A fact learned again since keeps its row and gains the support. */
export function bringBack(doc: MemoryDoc, id: string, at: number): MemoryDoc {
  const item = doc.archived?.find((have) => have.id === id);
  if (!item) return doc;
  const back: MemoryItem = { ...item, updatedAt: Math.max(item.updatedAt, at) };
  delete back.letGo;
  const rest = withoutArchived(doc, id);
  const live = rest.items.find((have) => have.id === id);
  if (live) {
    return bump({ ...rest, items: rest.items.map((have) => (have.id === id ? { ...have, support: have.support + item.support } : have)) });
  }
  return bump({ ...rest, items: [...rest.items, back] });
}

/** Delete from the list: the hard forget, with the digest a delete always leaves, so it is not learned again. */
export function forgetLetGo(doc: MemoryDoc, id: string): MemoryDoc {
  const item = doc.archived?.find((have) => have.id === id);
  if (!item) return doc;
  const text = item.action === "skill" ? (item.skill?.lesson ?? item.text) : item.text;
  return bump(withForgotten(withoutArchived(doc, id), item.mateId, text));
}
