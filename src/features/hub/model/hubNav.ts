// Which project and which project item is shown. Persisted locally.
import { useSyncExternalStore } from "react";
import { hubDefaultsOn } from "./hubDefaults";

/** No project chosen yet: the hub is the create-a-project empty state (HubSurface). A project is the unit of the hub. */
export const NO_PROJECT = "";

export type HubSelection = {
  /** The project id, or NO_PROJECT when none is chosen (first run, or the last one was removed). */
  project: string;
  /** Item id inside the project; "inbox" = the project's own Today, "" = nothing chosen. */
  item: string;
  /** Optional thing to scroll to and highlight, e.g. a chat message's refId. */
  focus?: string;
};

const KEY = "monocode:hub-nav";
const EVENT = "monocode:hub-nav-changed";
const DEFAULT: HubSelection = { project: NO_PROJECT, item: "" };

let cached: HubSelection | undefined;
function read(): HubSelection {
  if (cached) return cached;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<HubSelection> | null;
    cached = raw && typeof raw.project === "string" && typeof raw.item === "string" ? { project: raw.project, item: raw.item } : DEFAULT;
    // Before 23 Oct the top of the strip was "Today for all projects", stored as the project "today". There is no central
    // area now: an old selection opens on the first project's Today, the same as a first launch with no project chosen.
    if (cached.project === "today") cached = { project: NO_PROJECT, item: cached.item === "inbox" ? "" : cached.item };
  } catch {
    cached = DEFAULT;
  }
  return cached;
}

/** The project and item on screen. `/council` reads this without the app shell. */
export function currentHubSelection(): HubSelection {
  return read();
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

/**
 * One of the app's own views (Autopilot, New project, Restore) opens over the project Ash was last in: it is not a
 * project's item, but leaving it comes back to that project, and quitting from it opens the app there again.
 */
export function showAppItem(item: string): void {
  setHubSelection({ project: read().project, item });
}

/**
 * Back to the hub: the project's own Today — the one given, else the last project Ash was in. With no project at all it
 * opens the create-a-project empty state (HubSurface picks the first project once there is one).
 */
export function showProjectToday(projectId?: string): void {
  setHubSelection({ project: projectId ?? read().project, item: "inbox" });
}

/**
 * A Mono's own team (monoTeams.ts) is the item `team:<mono id>`, with no project selected (Today's): it isn't a project,
 * so the strip highlights none and the Monos rail marks the Mono instead.
 */
const MONO_TEAM_ITEM = "team:";

export function monoTeamItem(monoId: string): string {
  return `${MONO_TEAM_ITEM}${monoId}`;
}

/** The Mono whose own team is selected, if one is. */
export function monoTeamInView(sel: HubSelection): string | undefined {
  return sel.item.startsWith(MONO_TEAM_ITEM) ? sel.item.slice(MONO_TEAM_ITEM.length) || undefined : undefined;
}

/** True while one of the app's own views (hubNav.showAppItem) is open: it belongs to no project, so no project tile is lit. */
export function appItemInView(sel: HubSelection): boolean {
  return sel.item === "autopilot" || sel.item === "new-project" || sel.item === "restore" || !!monoTeamInView(sel);
}

/** True when a hub view (not Monocode's own workspace) fills the main area: a coding team or a Mono's team is a workspace. */
export function hubSurfaceOpen(sel: HubSelection): boolean {
  // Before anything was picked, upstream MonoCode's own build opens on its workspace, as upstream does (hubDefaultsOn).
  if (sel === DEFAULT && !hubDefaultsOn()) return false;
  if (monoTeamInView(sel)) return false;
  return sel.project === NO_PROJECT || sel.item !== "coding-team";
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

/**
 * Opening a Mono's own team (monoTeams.ts): its folder's workspace with the Sessions list, the Mono's chat pinned on top
 * and its workers under it, on the Mono's chat by default (`owner`) or the chat Ash was last in there. The app lends the
 * way; without it (a browse-only page) it only selects the item.
 */
export type MonoTeamTarget = { owner?: boolean };
let monoTeamOpener: ((monoId: string, target?: MonoTeamTarget) => void) | undefined;

export function setMonoTeamOpener(open: (monoId: string, target?: MonoTeamTarget) => void): () => void {
  monoTeamOpener = open;
  return () => {
    if (monoTeamOpener === open) monoTeamOpener = undefined;
  };
}

export function openMonoTeam(monoId: string, target?: MonoTeamTarget): void {
  if (monoTeamOpener) monoTeamOpener(monoId, target);
  else showAppItem(monoTeamItem(monoId));
}

/**
 * Opening a Mono's own chat from anywhere, Settings included (Bot changes' "Ask Alfred"): Settings closes and the
 * chat shows at once, in the Mono's team when it has one. Mac round 2 (21 Oct): through openMonoTeam alone the chat
 * opened behind Settings and only showed after Back. Without the app's opener it falls back to openMonoTeam.
 */
let monoChatOpener: ((monoId: string) => void) | undefined;

export function setMonoChatOpener(open: (monoId: string) => void): () => void {
  monoChatOpener = open;
  return () => {
    if (monoChatOpener === open) monoChatOpener = undefined;
  };
}

export function openMonoChat(monoId: string): void {
  if (monoChatOpener) monoChatOpener(monoId);
  else openMonoTeam(monoId, { owner: true });
}
