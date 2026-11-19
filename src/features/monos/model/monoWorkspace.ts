import { resolveModel } from "../../sessions/model/models";
import { HARNESS_LABEL, newSession, type HarnessId, type Session } from "../../sessions/model/session";
import {
  closeLeaf,
  leafIds,
  newTab,
  type WorkspaceTab,
} from "../../workspace/model/layout";
import { workspaceTabCwd } from "../../workspace/model/workspaceTabGroups";
import { sameProjectPath } from "../../projects/model/recents";
import {
  findMono,
  isMonoSession,
  isMonoSideChat,
  monoForSession,
  monoProjectSession,
  monoRoomSession,
  monoSessionProject,
  saveMonoProjectSession,
  saveMonoRoomSession,
  saveMonoSessionId,
  saveMonoSideChat,
  replaceMonoSideChat,
} from "./mono";
import { stampFirstMate } from "./monoMate";
import { withMonoFast } from "./monoRun";
import { forgetAgentContext } from "./monoFiles";
import { forgetMonoRotation } from "./monoRotation";
import { segmentStore } from "./chatSegments";
import { leadWorkingFolder } from "../../hub/model/hubLeads";

const openingMonos = new Map<string, Promise<Session | undefined>>();

/** Fast mode from the Mono, when this model offers it. Otherwise the session's own settings stay. */
function withEngineFast(session: Session, engineFast: boolean | undefined): Session {
  return {
    ...session,
    modelSettings: withMonoFast(resolveModel(session.harness, session.model), session.modelSettings, engineFast),
  };
}

/**
 * Load the Mono's conversation without opening or replacing a workspace tab.
 * A new one starts with Auto permissions in the home folder: no single
 * project is its own.
 */
export function ensureMonoSession(
  monoId: string,
  host: {
    home(): Promise<string>;
    load(id: string): Promise<Session | null | undefined>;
    create(cwd: string): Session;
    add(session: Session): void;
  },
): Promise<Session | undefined> {
  const pending = openingMonos.get(monoId);
  if (pending) return pending;
  const opening = loadMonoSession(monoId, host).finally(() => {
    if (openingMonos.get(monoId) === opening) openingMonos.delete(monoId);
  });
  openingMonos.set(monoId, opening);
  return opening;
}

async function loadMonoSession(
  monoId: string,
  host: Parameters<typeof ensureMonoSession>[1],
): Promise<Session | undefined> {
  const mono = findMono(monoId);
  if (!mono) return undefined;
  if (mono.sessionId) {
    const existing = await host.load(mono.sessionId);
    // WP-21: a Mono's chat is a first mate. The same object, so the open list keeps the flag.
    if (existing) return stampFirstMate(existing);
  }
  // A project's Lead (the hub's "<Project> lead") works in its project's folder; any other Mono starts at home.
  const home = leadWorkingFolder(monoId) ?? (await host.home());
  // Removed while the home folder was looked up.
  if (!findMono(monoId)) return undefined;
  // A Mono with its own engine (the hub's team is noted as Claude Code; a setup import may bring another engine and a
  // model) starts there; any other, or an engine this build doesn't know, uses the app's default.
  const engine = mono.engine && Object.prototype.hasOwnProperty.call(HARNESS_LABEL, mono.engine) ? (mono.engine as HarnessId) : undefined;
  const created = host.create(home);
  const own = engine && (engine !== created.harness || (mono.engineModel && mono.engineModel !== created.model));
  const session: Session = stampFirstMate({ ...withEngineFast(own ? newSession(engine, home, mono.engineModel) : created, mono.engineFast), runtimeMode: "auto" });
  saveMonoSessionId(monoId, session.id);
  host.add(session);
  return session;
}

const openingRooms = new Map<string, Promise<Session | undefined>>();

/**
 * The Mono's session for one room conversation (r52), made the first time that conversation gives it a turn: its own
 * Claude session, like a separate chat, so the room's turns stay out of its 1:1 chat and go when the conversation is
 * deleted. It starts where its 1:1 chat would (its Lead's project folder, else home) on its engine. Durable facts reach
 * it through its memory files and the room's memory primer, not through the 1:1 chat's history.
 */
export function ensureMonoRoomSession(
  monoId: string,
  chatId: string,
  convId: string,
  host: Parameters<typeof ensureMonoSession>[1],
): Promise<Session | undefined> {
  const key = JSON.stringify([monoId, chatId, convId]);
  const pending = openingRooms.get(key);
  if (pending) return pending;
  const opening = loadMonoRoomSession(monoId, chatId, convId, host).finally(() => {
    if (openingRooms.get(key) === opening) openingRooms.delete(key);
  });
  openingRooms.set(key, opening);
  return opening;
}

async function loadMonoRoomSession(
  monoId: string,
  chatId: string,
  convId: string,
  host: Parameters<typeof ensureMonoSession>[1],
): Promise<Session | undefined> {
  const mono = findMono(monoId);
  if (!mono) return undefined;
  const known = monoRoomSession(monoId, chatId, convId);
  if (known) {
    const existing = await host.load(known);
    // WP-21: a room chat is the same Mono, so it is a first mate too.
    if (existing) return stampFirstMate(existing);
  }
  const home = leadWorkingFolder(monoId) ?? (await host.home());
  if (!findMono(monoId)) return undefined;
  const engine = mono.engine && Object.prototype.hasOwnProperty.call(HARNESS_LABEL, mono.engine) ? (mono.engine as HarnessId) : undefined;
  const created = host.create(home);
  const own = engine && (engine !== created.harness || (mono.engineModel && mono.engineModel !== created.model));
  const session: Session = stampFirstMate({ ...withEngineFast(own ? newSession(engine, home, mono.engineModel) : created, mono.engineFast), runtimeMode: "auto" });
  if (!saveMonoRoomSession(monoId, chatId, convId, session.id)) return undefined;
  host.add(session);
  return session;
}

const openingProjects = new Map<string, Promise<Session | undefined>>();

/**
 * Dropwave: the Mono's own chat for one project (the Chief of Staff has one in every project, geared to it), made the
 * first time it is opened there. It works in the project's folder when it has one, else where its chat on Home does.
 */
export function ensureMonoProjectSession(
  monoId: string,
  project: { id: string; folder?: string | null },
  host: Parameters<typeof ensureMonoSession>[1],
): Promise<Session | undefined> {
  const key = JSON.stringify([monoId, project.id]);
  const pending = openingProjects.get(key);
  if (pending) return pending;
  const opening = loadMonoProjectSession(monoId, project, host).finally(() => {
    if (openingProjects.get(key) === opening) openingProjects.delete(key);
  });
  openingProjects.set(key, opening);
  return opening;
}

async function loadMonoProjectSession(
  monoId: string,
  project: { id: string; folder?: string | null },
  host: Parameters<typeof ensureMonoSession>[1],
): Promise<Session | undefined> {
  const mono = findMono(monoId);
  if (!mono) return undefined;
  const known = monoProjectSession(monoId, project.id);
  if (known) {
    const existing = await host.load(known);
    if (existing) return stampFirstMate(existing);
  }
  const folder = project.folder?.trim() || (await host.home());
  if (!findMono(monoId)) return undefined;
  const engine = mono.engine && Object.prototype.hasOwnProperty.call(HARNESS_LABEL, mono.engine) ? (mono.engine as HarnessId) : undefined;
  const created = host.create(folder);
  const own = engine && (engine !== created.harness || (mono.engineModel && mono.engineModel !== created.model));
  const session: Session = stampFirstMate({ ...(own ? newSession(engine, folder, mono.engineModel) : created), runtimeMode: "auto" });
  if (!saveMonoProjectSession(monoId, project.id, session.id)) return undefined;
  host.add(session);
  return session;
}

/**
 * Dropwave (Ash, 11 Nov: "a first mate can have multiple chats"): a further chat with the same first mate, started
 * from "New chat" beside its chat. Its own conversation on the first mate's engine, in the folder given (the list it
 * was started from), else where its main chat works. The first mate's memory files reach it as they reach every chat
 * of its own; the main chat's history does not.
 */
export async function startMonoSideChat(
  monoId: string,
  host: Parameters<typeof ensureMonoSession>[1],
  folder?: string | null,
  /** The chat Ash is on: with no model of the Mono's own, the new chat runs on what this one runs on (Ash 12 Nov). */
  like?: Pick<Session, "harness" | "model" | "modelSettings">,
): Promise<Session | undefined> {
  const mono = findMono(monoId);
  if (!mono) return undefined;
  const cwd = folder?.trim() || leadWorkingFolder(monoId) || (await host.home());
  if (!findMono(monoId)) return undefined;
  const engine = mono.engine && Object.prototype.hasOwnProperty.call(HARNESS_LABEL, mono.engine) ? (mono.engine as HarnessId) : undefined;
  const created = !engine && like ? newSession(like.harness, cwd, like.model, "auto", like.modelSettings) : host.create(cwd);
  const own = engine && (engine !== created.harness || (mono.engineModel && mono.engineModel !== created.model));
  const base = withEngineFast(own ? newSession(engine, cwd, mono.engineModel) : created, mono.engineFast);
  const withEffort = engine && mono.engineEffort ? { ...base, modelSettings: { ...base.modelSettings, effort: mono.engineEffort } } : base;
  const session: Session = stampFirstMate({ ...withEffort, runtimeMode: "auto" });
  if (!saveMonoSideChat(monoId, session.id)) return undefined;
  host.add(session);
  return session;
}

/** Reset only the Mono's chat, keeping its identity, habits and memory. */
export async function resetMonoSession(
  current: Session,
  host: {
    stop(id: string): Promise<Session | undefined>;
    remove(session: Session): Promise<void>;
    replace(session: Session): void;
    /**
     * SC-19: the work the old chat still owned (running, waiting, asked, or finished with its report not yet told) goes
     * to the new chat (ownerMove.ts), so a worker's report still has a chat to reach. Called once the new chat is the
     * Mono's. A failure is logged and never undoes the reset: the old chat is already gone.
     */
    moveWork?(old: Session, fresh: Session): Promise<void>;
  },
): Promise<Session> {
  const monoId = monoForSession(current.id)?.id;
  const stopped = (await host.stop(current.id)) ?? current;
  // WP-21: the new chat is still this Mono's, so it stays a first mate.
  const fresh = stampFirstMate(newSession(
    stopped.harness,
    stopped.cwd,
    stopped.model,
    stopped.runtimeMode,
    stopped.modelSettings,
  ));
  // A failed deletion must leave the original conversation selected.
  await host.remove(stopped);
  forgetAgentContext(current.id);
  forgetMonoRotation(current.id);
  void segmentStore().forget(current.id).catch(() => undefined);
  // Dropwave: a project's own chat with the Mono, or one of its further chats (G2), is reset in its place; its main
  // chat is left alone.
  const projectId = monoSessionProject(current.id);
  if (monoId && projectId) saveMonoProjectSession(monoId, projectId, fresh.id);
  else if (monoId && isMonoSideChat(current.id)) replaceMonoSideChat(monoId, current.id, fresh.id);
  else if (monoId) saveMonoSessionId(monoId, fresh.id);
  host.replace(fresh);
  try {
    await host.moveWork?.(stopped, fresh);
  } catch (error) {
    console.error("Could not move the reset chat's tasks to its new chat", error);
  }
  return fresh;
}

/** Migrate the earlier agent tabs into a separate view, keeping ordinary panes. */
export function detachMonoTabs(
  tabs: WorkspaceTab[],
  sessions: Session[],
  activeTabId: string,
  fallbackCwd: string,
  createSession: (cwd: string) => Session,
) {
  let changed = false;
  const removedProjects = new Set<string>();
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const agentViewId =
    activeTab && isMonoSession(activeTab.focusedId)
      ? activeTab.focusedId
      : undefined;
  const regularTabs: WorkspaceTab[] = [];
  for (const tab of tabs) {
    const agentIds = leafIds(tab.layout).filter(isMonoSession);
    if (agentIds.length === 0) {
      regularTabs.push(tab);
      continue;
    }
    changed = true;
    const cwd = workspaceTabCwd(tab, sessions) ?? fallbackCwd;
    let remaining: WorkspaceTab | null = tab;
    for (const id of agentIds) {
      if (remaining) remaining = closeLeaf(remaining, id);
    }
    if (remaining) regularTabs.push(remaining);
    else removedProjects.add(cwd);
  }
  if (!changed) return undefined;

  const addedSessions: Session[] = [];
  for (const cwd of removedProjects) {
    if (
      regularTabs.some((tab) => {
        const project = workspaceTabCwd(tab, sessions);
        return project && sameProjectPath(project, cwd);
      })
    )
      continue;
    const session = createSession(cwd);
    addedSessions.push(session);
    regularTabs.push(newTab(session.id));
  }
  const activeCwd = activeTab
    ? (workspaceTabCwd(activeTab, sessions) ?? fallbackCwd)
    : fallbackCwd;
  const allSessions = [...sessions, ...addedSessions];
  const nextActive =
    regularTabs.find((tab) => tab.id === activeTabId) ??
    regularTabs.find((tab) => {
      const cwd = workspaceTabCwd(tab, allSessions);
      return cwd && sameProjectPath(cwd, activeCwd);
    }) ??
    regularTabs[0];
  return {
    tabs: regularTabs,
    addedSessions,
    activeTabId: nextActive.id,
    agentViewId,
  };
}
