// Dropwave (Ash, 11 Nov): the Inbox holds two things, what asks for an answer and the work items from GitHub and the
// other connections. They stay apart, and one tap shows both, only the asks, or only the work items.
import { useSyncExternalStore } from "react";

export type InboxShow = "all" | "asks" | "items";

const KEY = "monocode:inbox-show";
const listeners = new Set<() => void>();
let held: InboxShow | undefined;

function stored(): InboxShow {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "asks" || raw === "items" ? raw : "all";
  } catch {
    return "all";
  }
}

export function inboxShow(): InboxShow {
  return held ?? stored();
}

export function setInboxShow(show: InboxShow): void {
  held = show;
  try {
    if (show === "all") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, show);
  } catch {
    // Not kept past this run.
  }
  listeners.forEach((listener) => listener());
}

export function useInboxShow(): InboxShow {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    inboxShow,
    inboxShow,
  );
}

/** Tests: forget the choice. */
export function resetInboxShow(): void {
  held = undefined;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}

/** Which of the Inbox's two lists a choice shows. */
export function inboxParts(show: InboxShow): { asks: boolean; items: boolean } {
  return { asks: show !== "items", items: show !== "asks" };
}
