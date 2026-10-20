// The coding team: a hub project's code folder, with its chats in MonoCode's own workspace (HubProjectItems'
// "Coding team"). Ash, 20 Oct: "mainly the coding team is the main place i want to talk to basically that's the main
// area for tasks and stuff", and "I don't talk to workers. I only talk to orchestrators." So every top-level chat Ash
// starts there is an orchestrator, like the project's Lead: it gets the delegate tool and its rules (hubMcp.ts,
// monoFiles.ts), works on the project (ASH_PROJECT and its memory primer), and shows its workers' stuck cards and the
// "2 working: API · 1 stuck: Tests" line. A chat it starts (delegate_task, sessions.start) stays a worker.
//
// Which chats those are is settled once, when a chat in a project's folder takes a turn (noteCodingTeamChat), and kept
// on this Mac by chat id: who a chat is must be known from its id alone, by its delegate tool's identity when Claude
// Code starts (hubMcp.ts) and by its delegation rows after a restart, while the chat isn't open.
import { useSyncExternalStore } from "react";
import { pathKey } from "../../../shared/lib/paths";
import { isGlobalProject } from "./hubProjects";
import type { HubProject } from "./types";

const KEY = "monocode:coding-team-chats";

/** chat id -> the hub project id whose coding team it is in. */
let chats: Record<string, string> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function load(): Record<string, string> {
  if (chats) return chats;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    chats =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {};
  } catch {
    chats = {};
  }
  return chats;
}

function save(next: Record<string, string>): void {
  chats = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* kept for this run; the chat is noted again on its next turn */
  }
  version++;
  listeners.forEach((listener) => listener());
}

/** What decides whether a chat is in a coding team: its id, its folder and how it was started. */
export type CodingTeamCandidate = {
  id: string;
  cwd: string;
  ephemeral?: boolean;
  /** An orchestration run's lead or worker: it has its own controls. */
  orchestrationLeadId?: string;
  /** A question asked from the Inbox, not a chat. */
  inboxAsk?: unknown;
  /** A run an automation started, not Ash. */
  automationId?: string;
};

/**
 * The project whose coding team this chat is in: a top-level chat in a hub project's code folder. Never a Mono's own
 * chat or a habit run (they are who they are), never a chat another chat started (`app-<caller>-<request>`: a
 * worker), and never a throwaway, an orchestration run, an Inbox question or an automation's run. `ash` (Ash's global
 * memory) has no coding team.
 */
export function codingTeamProjectFor(
  chat: CodingTeamCandidate,
  projects: readonly HubProject[],
  others: { isMono(id: string): boolean; isHabitRun(id: string): boolean },
): HubProject | undefined {
  if (
    chat.id.startsWith("app-") ||
    chat.ephemeral ||
    chat.orchestrationLeadId ||
    chat.inboxAsk ||
    chat.automationId ||
    !chat.cwd ||
    others.isMono(chat.id) ||
    others.isHabitRun(chat.id)
  )
    return undefined;
  const key = pathKey(chat.cwd);
  return projects.find((project) => !!project.folder && !isGlobalProject(project.id) && pathKey(project.folder) === key);
}

/** Remember that this chat is in that project's coding team (before its turn starts, so its CLI starts as one). */
export function noteCodingTeamChat(chatId: string, projectId: string): void {
  if (load()[chatId] === projectId) return;
  save({ ...load(), [chatId]: projectId });
}

/** The hub project whose coding team this chat is in, or undefined (a Mono's chat, a worker, any other chat). */
export function codingTeamChatProject(chatId: string): string | undefined {
  return load()[chatId];
}

export function isCodingTeamChat(chatId: string): boolean {
  return !!codingTeamChatProject(chatId);
}

/** A deleted chat leaves the coding team. */
export function forgetCodingTeamChat(chatId: string): void {
  if (!(chatId in load())) return;
  const next = { ...load() };
  delete next[chatId];
  save(next);
}

/**
 * The coding-team chat that started this worker (`app-<chat>-<request>`), however deep, for a worker whose row has aged
 * out: the longest chat id it starts with.
 */
export function startedByCodingTeamChat(sessionId: string): string | undefined {
  if (!sessionId.startsWith("app-")) return undefined;
  let best: string | undefined;
  for (const chat of Object.keys(load())) {
    if (sessionId.startsWith(`app-${chat}-`) && (!best || chat.length > best.length)) best = chat;
  }
  if (best) return best;
  // A worker's worker: `app-app-<chat>-<r1>-<r2>`.
  return startedByCodingTeamChat(sessionId.slice(4));
}

/** How a coding-team chat signs what it sends ("[MonoCode brief from EXO coding team]"). */
export function codingTeamName(project: Pick<HubProject, "name" | "shortName"> | undefined): string {
  const name = (project?.shortName || project?.name || "").trim();
  return name ? `${name} coding team` : "Coding team";
}

export function useCodingTeamVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}

/** Tests: forget every chat. */
export function resetCodingTeamChats(): void {
  chats = undefined;
  version++;
}
