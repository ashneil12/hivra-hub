// WP-240: the no-model repair pass, run with every batch. Four hard rules, no model and nothing sent anywhere:
//   1. a fact whose end date (`validTo`) has passed is let go as expired;
//   2. a single-source guess not repeated in STALE_DAYS is let go as stale (not an event or a possession, which are
//      true once said, and never a fact the person accepted or wrote);
//   3. two facts that say the same thing once case, spacing and punctuation are ignored become one: the stronger is
//      kept with both supports, the other is let go as a duplicate of it;
//   4. the "Let go" list keeps ARCHIVE_CAP items, oldest out first (withArchived).
// fade.ts stays for ranking and the "still true?" ask only, so two decays never act on one field: this pass reads
// support, dates and state, never `fade`.
// (Idea: Nod by n8n, Apache-2.0, src/server/memory-lint.ts `repair` and `better`. No code copied.)

import { bump, type MemoryDoc, type MemoryItem } from "./doc";
import { letGoCopy, withArchived } from "./letGo";

export const STALE_DAYS = 60;
const DAY = 86_400_000;

/** The words of a fact with case, spacing and punctuation taken out, for the duplicate rule. */
export function sameKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function owned(item: MemoryItem): boolean {
  return item.state === "confirmed" || item.state === "edited";
}

/** The stronger of two: the person's own first, then more support, then the newer. Positive keeps `a`. */
function stronger(a: MemoryItem, b: MemoryItem): number {
  return Number(owned(a)) - Number(owned(b)) || a.support - b.support || a.updatedAt - b.updatedAt;
}

function lastSaid(item: MemoryItem): number {
  return Math.max(item.createdAt, item.updatedAt, item.lastUsedAt ?? 0);
}

export type RepairResult = { doc: MemoryDoc; expired: number; stale: number; duplicates: number };

export function repairDoc(doc: MemoryDoc, now: number): RepairResult {
  const today = new Date(now).toISOString().slice(0, 10);
  const out: MemoryItem[] = [];
  let expired = 0;
  let stale = 0;
  let duplicates = 0;
  let items = doc.items.filter((item) => {
    // A parked clash waits for the person's own three choices; a proposal about another fact is not a fact.
    if (item.dispute || item.action !== "add") return true;
    if (item.validTo && item.validTo < today) {
      out.push(letGoCopy(item, "expired", now));
      expired += 1;
      return false;
    }
    if (
      !owned(item) &&
      item.support < 2 &&
      item.kind !== "event" &&
      item.kind !== "possession" &&
      now - lastSaid(item) > STALE_DAYS * DAY
    ) {
      out.push(letGoCopy(item, "stale", now));
      stale += 1;
      return false;
    }
    return true;
  });

  const groups = new Map<string, MemoryItem>();
  const merged = new Map<string, MemoryItem>();
  const dropped = new Set<string>();
  for (const item of items) {
    if (item.dispute || item.action !== "add") continue;
    const key = `${item.mateId}\n${sameKey(item.text)}`;
    if (!sameKey(item.text)) continue;
    const have = groups.get(key);
    if (!have) {
      groups.set(key, item);
      continue;
    }
    const [keep, drop] = stronger(have, item) >= 0 ? [have, item] : [item, have];
    const kept: MemoryItem = { ...keep, support: keep.support + drop.support };
    groups.set(key, kept);
    merged.set(keep.id, kept);
    merged.delete(drop.id);
    dropped.add(drop.id);
    out.push(letGoCopy(drop, "duplicate", now, keep.id));
    duplicates += 1;
  }
  if (dropped.size) {
    items = items.filter((item) => !dropped.has(item.id)).map((item) => merged.get(item.id) ?? item);
  }
  if (!out.length) return { doc, expired, stale, duplicates };
  return { doc: bump(withArchived({ ...doc, items }, out)), expired, stale, duplicates };
}
