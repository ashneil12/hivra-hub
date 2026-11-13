// The Needs you roll-up in the pinned Chief of Staff chat: when the one Needs you list (needsYou.ts) gains items, one
// muted app line in the Chief of Staff's own chat names them, so Ash sees what needs him where he talks instead of
// opening Home or the Inbox. Capy's Captain pastes its digest's Needs you slice into the chat the same way. Plain code:
// the line is built from the list, never by a model, and an app line is not sent to the model, so it costs no tokens.

import { isOwnerKey } from "../../chief/model/captain";
import type { Block } from "../../sessions/model/session";
import { markOf } from "./setAside";
import type { NeedsItem } from "./needsYou";

/** At most this many items are named in one line; the rest are a count. */
export const ROLLUP_NAMED = 5;
const SENTENCE_MAX = 140;

export type RollupState = {
  /** Every item mark (key and words) the chat has already been told about, or that was there when it started. */
  told: ReadonlySet<string>;
};

/** What a line carries for one item: its key and current words. */
function itemMark(item: Pick<NeedsItem, "key" | "kind" | "sentence">): string {
  return `${item.key}\n${markOf(item)}`;
}

/** The first look only learns what is there: nothing waiting since before the app opened is announced again. */
export function seedRollup(items: readonly NeedsItem[]): RollupState {
  return { told: new Set(items.map(itemMark)) };
}

function short(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= SENTENCE_MAX ? one : `${one.slice(0, SENTENCE_MAX - 1).trimEnd()}…`;
}

/** Yours alone: a decision or check only the owner answers (captain.ts isOwnerKey), or a stopped job. */
export function isAshsCall(item: Pick<NeedsItem, "kind" | "decisionKey" | "gateKey">): boolean {
  return item.kind === "stopped" || isOwnerKey(item.decisionKey) || isOwnerKey(item.gateKey);
}

/**
 * The app line for the items that are new since the chat was last told, or null when nothing is new. A key that left
 * the list and comes back with the same words is not announced twice in one run of the app.
 */
export function rollupLine(
  items: readonly NeedsItem[],
  state: RollupState,
  now: number,
  label: (item: NeedsItem) => string | undefined = () => undefined,
): { block: Block; state: RollupState } | null {
  const fresh = items.filter((item) => !state.told.has(itemMark(item)));
  if (fresh.length === 0) return null;
  const told = new Set(state.told);
  for (const item of fresh) told.add(itemMark(item));
  const yours = fresh.filter(isAshsCall);
  const named = [...yours, ...fresh.filter((item) => !isAshsCall(item))].slice(0, ROLLUP_NAMED);
  const lines = named.map((item) => {
    const where = label(item);
    return `${isAshsCall(item) ? "Yours: " : ""}${where ? `${where}: ` : ""}${short(item.sentence)}`;
  });
  const more = fresh.length - named.length;
  const head = fresh.length === 1 ? "Needs you now" : `Needs you now (${fresh.length} new)`;
  const text = [`${head}${yours.length ? ", Ash" : ""}:`, ...lines.map((line) => `- ${line}`), ...(more > 0 ? [`- and ${more} more in Needs you`] : [])].join("\n");
  return {
    block: { id: `needs-rollup-${now}`, role: "system", text } as Block,
    state: { told },
  };
}
