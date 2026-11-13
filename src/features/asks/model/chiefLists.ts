// Where the Chief of Staff's three lists (Needs you, You asked, Working) show (Ash, 13 Nov: "both a and c with
// customisation"): as buttons at the top of its chat, in the panel beside it, or not at all. Kept per window install.
import { useSyncExternalStore } from "react";

export type ChiefLists = "top" | "side" | "off";

const KEY = "monocode.chiefLists";
const listeners = new Set<() => void>();

export function chiefLists(): ChiefLists {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "side" || value === "off") return value;
  } catch {
    return "top";
  }
  return "top";
}

export function setChiefLists(next: ChiefLists): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Without storage the choice lasts while this window lives.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChiefLists(): ChiefLists {
  return useSyncExternalStore(subscribe, chiefLists, () => "top" as const);
}

/**
 * Whether arriving on a chat should open the panel beside it: only the Chief of Staff's main chat, and only with
 * "beside the chat" picked. Every other first mate's chat opens without its panel (Ash, 12 Nov).
 */
export function chiefListsOpenPanel(place: ChiefLists, viewSessionId: string | null | undefined, chiefSessionId: string | null | undefined): boolean {
  return place === "side" && !!viewSessionId && viewSessionId === chiefSessionId;
}

/** The tab the Chief of Staff's panel should move to when the lists arrive or leave; undefined leaves it where it is. */
export function chiefListsTab<T extends string>(showing: boolean, tab: T): "needs" | "sessions" | undefined {
  if (showing) return tab === "sessions" ? "needs" : undefined;
  return tab === "needs" || tab === "asked" || tab === "working" ? "sessions" : undefined;
}
