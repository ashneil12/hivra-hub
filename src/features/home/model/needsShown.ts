// Home shows the first five needs. The count is the whole list (needsCount).
// A stopped or failed row leads, then anything blocking a ship, then questions.
// Within one tier the older row stays first.

import type { NeedsItem } from "../../needs/model/needsYou";

export const HOME_NEEDS_SHOWN = 5;

const SHIP_WORD = /\bship\b/i;

/** 0 leads. A failed lead is kind "stopped" (WP-210). A question only blocks a ship when it asks to ship. */
export function needsRank(item: Pick<NeedsItem, "kind" | "sentence">): 0 | 1 | 2 {
  if (item.kind === "stopped") return 0;
  if (item.kind === "merge" || item.kind === "check") return 1;
  if (item.kind === "question" && SHIP_WORD.test(item.sentence)) return 1;
  return 2;
}

function byUrgency(a: NeedsItem, b: NeedsItem): number {
  return needsRank(a) - needsRank(b) || a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** `items` is the one list (needsLive.useNeedsYou), already deduped. Home only orders and cuts it. */
export function needsShown(items: readonly NeedsItem[], _now?: number): NeedsItem[] {
  return [...items].sort(byUrgency).slice(0, HOME_NEEDS_SHOWN);
}
