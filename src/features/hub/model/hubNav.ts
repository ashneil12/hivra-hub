// Which project and which project item is shown. Persisted locally.
import { useSyncExternalStore } from "react";
import { hubDefaultsOn } from "./hubDefaults";

/** No project chosen yet: the hub is the create-a-project empty state (HubSurface). A project is the unit of the hub. */
export const NO_PROJECT = "";

export type HubSelection = {
  /** The project id, or NO_PROJECT when none is chosen (first run, or the last one was removed). */
  project: string;
  /** Item id inside the project. "coding-team" is the project's home. "" = nothing chosen. */
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
    // area now: an old selection is no project, and the app opens the first one's coding team.
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

/** WP-73: Home watches the selection. Leaving and coming back is still a move. */
export function subscribeHubSelection(cb: () => void): () => void {
  return subscribe(cb);
}

export function useHubSelection(): HubSelection {
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * One of the app's own views (Autopilot, New project, Restore) opens over the project Ash was last in: it is not a
 * project's item, but leaving it comes back to that project, and quitting from it opens the app there again.
 */
/** Dropwave: a project's own home (HubSurface shows HomeView for that project). The rail opens it. */
export const PROJECT_HOME_ITEM = "project-home";

export function showProjectHome(projectId: string): void {
  setHubSelection({ project: projectId, item: PROJECT_HOME_ITEM });
}

export function showAppItem(item: string): void {
  setHubSelection({ project: read().project, item });
}

/**
 * Back to the hub: the project's coding team — the one given, else the last project Ash was in. With no project at all
 * it opens the create-a-project empty state (HubSurface picks the first project once there is one). WP-06: not Today.
 */
export function showProjectToday(projectId?: string): void {
  const project = projectId ?? read().project;
  if (project && project !== NO_PROJECT) {
    openCodingTeam(project);
    return;
  }
  setHubSelection({ project: NO_PROJECT, item: "" });
}

/** Today, Being built, the project's Decisions page and Builds. WP-06: these are not screens any more. */
const RETIRED_HUB_ITEMS = new Set(["inbox", "being-built", "decisions", "builds"]);

export function retiredHubItem(item: string): boolean {
  return RETIRED_HUB_ITEMS.has(item);
}

export type HubOpenRequest = { kind: "inbox" } | { kind: "selection"; selection: HubSelection };

/**
 * A settings leave (OPEN_HUB_EVENT). "inbox" is the retired Today item: that request is the real Inbox, not a hub
 * selection. Anything else is a selection. A missing or blank detail is ignored.
 */
export function resolveHubOpen(detail: unknown): HubOpenRequest | null {
  if (!detail || typeof detail !== "object") return null;
  const record = detail as { project?: unknown; item?: unknown };
  if (typeof record.project !== "string" || typeof record.item !== "string") return null;
  if (!record.project.trim() || !record.item.trim()) return null;
  if (record.item === "inbox") return { kind: "inbox" };
  return { kind: "selection", selection: { project: record.project, item: record.item } };
}

/** A project with no code folder. A hub page, so the previous project's workspace does not stay on screen. */
export const NO_CODE_ITEM = "no-code";

/** A code folder is a non-blank path. Whitespace and a blank line are not one. */
export function projectHasCodeFolder(folder: string | null | undefined): folder is string {
  return typeof folder === "string" && folder.trim().length > 0;
}

/** Where a project opens. No folder: the no-code page. A folder: its coding team, which is the workspace. */
export function projectHomeSelection(project: { id: string; folder?: string | null }): HubSelection {
  if (!projectHasCodeFolder(project.folder)) return { project: project.id, item: NO_CODE_ITEM };
  return { project: project.id, item: "coding-team" };
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

/**
 * The rail opens a Mono on its own (people, not its team). While that Mono's team is still the selected item, Team
 * stays pressed and the chat opens inside the team. The project's coding team is the workspace behind the chat: an
 * empty item would open the hub surface, which then opens a Lead over this chat. No project to stand on: leave the
 * selection alone. Another Mono's team, or any other item, is left as it is.
 */
export function selectionLeavingOwnTeam(sel: HubSelection, monoId: string): HubSelection | undefined {
  if (!sel.project || monoTeamInView(sel) !== monoId) return undefined;
  return { project: sel.project, item: "coding-team" };
}

/** True while one of the app's own views (hubNav.showAppItem) is open: it belongs to no project, so no project tile is lit. */
export function appItemInView(sel: HubSelection): boolean {
  // WP-73: Home is the app's own view. The project tile stays unlit, and the no-project redirect does not take it.
  // WP-219: Agents is an app view, so the no-project redirect does not take it.
  return sel.item === "home" || sel.item === "agents" || sel.item === "autopilot" || sel.item === "new-project" || sel.item === "restore" || !!monoTeamInView(sel);
}

/** True when a hub view (not Monocode's own workspace) fills the main area: a coding team or a Mono's team is a workspace. */
export function hubSurfaceOpen(sel: HubSelection): boolean {
  // Before anything was picked, upstream MonoCode's own build opens on its workspace, as upstream does (hubDefaultsOn).
  if (sel === DEFAULT && !hubDefaultsOn()) return false;
  if (monoTeamInView(sel)) return false;
  // WP-06: Today, Being built, Decisions and Builds are not a surface. The coding team is the workspace.
  if (sel.project !== NO_PROJECT && retiredHubItem(sel.item)) return false;
  return sel.project === NO_PROJECT || sel.item !== "coding-team";
}

/**
 * Opening a project's coding team (Ash, 20 Oct: "mainly the coding team is the main place i want to talk to"): its
 * folder's workspace with the Sessions list, on its Lead's chat by default (`lead`), or the chat Ash was last in there.
 * The app lends the way (App.tsx); a hub view that offers "Open in coding team" calls it. Without the app
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
/** Dropwave: `project` opens the Mono's own chat for that project (the Chief of Staff's, geared to it). */
/** `main`: its own chat (the one text was typed into), not the chat Ash was last on with it. */
export type MonoChatTarget = { project?: string; main?: boolean };
let monoChatOpener: ((monoId: string, target?: MonoChatTarget) => void) | undefined;

export function setMonoChatOpener(open: (monoId: string, target?: MonoChatTarget) => void): () => void {
  monoChatOpener = open;
  return () => {
    if (monoChatOpener === open) monoChatOpener = undefined;
  };
}

/** Ash (12 Nov): a first mate's settings (its model, name, permissions) from a right-click or from Settings. */
let monoSettingsOpener: ((monoId: string) => void) | undefined;

export function setMonoSettingsOpener(open: (monoId: string) => void): () => void {
  monoSettingsOpener = open;
  return () => {
    if (monoSettingsOpener === open) monoSettingsOpener = undefined;
  };
}

/** Opens the first mate's chat with its settings over it. False when the app can't (no window ready). */
export function openMonoSettings(monoId: string): boolean {
  if (!monoSettingsOpener || !monoId.trim()) return false;
  monoSettingsOpener(monoId);
  return true;
}

export function openMonoChat(monoId: string, target?: MonoChatTarget): void {
  if (monoChatOpener) monoChatOpener(monoId, target);
  else openMonoTeam(monoId, { owner: true });
}
