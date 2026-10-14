// Which project and which project item is shown. Persisted locally.
import { useSyncExternalStore } from "react";

export type HubSelection = {
  /** "today" = Today for all projects (top of the strip). */
  project: string;
  /** Item id inside the project; "inbox" = the project's own Today. */
  item: string;
};

const KEY = "monocode:hub-nav";
const EVENT = "monocode:hub-nav-changed";
const DEFAULT: HubSelection = { project: "today", item: "inbox" };

let cached: HubSelection | undefined;
function read(): HubSelection {
  if (cached) return cached;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<HubSelection> | null;
    cached = raw && typeof raw.project === "string" && typeof raw.item === "string" ? { project: raw.project, item: raw.item } : DEFAULT;
  } catch {
    cached = DEFAULT;
  }
  return cached;
}

export function setHubSelection(next: HubSelection): void {
  cached = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* best effort */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

export function useHubSelection(): HubSelection {
  return useSyncExternalStore(subscribe, read, read);
}

/** True when a hub view (not Monocode's own workspace) fills the main area. */
export function hubSurfaceOpen(sel: HubSelection): boolean {
  return sel.project === "today" || sel.item !== "coding-team";
}
