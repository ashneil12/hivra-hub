// Which project and which project item is shown. Persisted locally.
import { useSyncExternalStore } from "react";

export type HubSelection = {
  /** "today" = Today for all projects (top of the strip). */
  project: string;
  /** Item id inside the project; "inbox" = the project's own Today. */
  item: string;
  /** Optional thing to scroll to and highlight, e.g. a chat message's refId. */
  focus?: string;
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

/**
 * Opening a project's coding team (Ash, 20 Oct: "mainly the coding team is the main place i want to talk to"): its
 * folder's workspace with the Sessions list, on its Lead's chat by default (`lead`), or the chat Ash was last in there.
 * The app lends the way (App.tsx); a hub view that offers "Open in coding team" (Being built) calls it. Without the app
 * (a browse-only page) it only selects the item.
 */
export type CodingTeamTarget = { lead?: boolean };
let codingTeamOpener: ((projectId: string, target?: CodingTeamTarget) => void) | undefined;

export function setCodingTeamOpener(open: (projectId: string, target?: CodingTeamTarget) => void): () => void {
  codingTeamOpener = open;
  return () => {
    if (codingTeamOpener === open) codingTeamOpener = undefined;
  };
}

export function openCodingTeam(projectId: string, target?: CodingTeamTarget): void {
  if (codingTeamOpener) codingTeamOpener(projectId, target);
  else setHubSelection({ project: projectId, item: "coding-team" });
}
