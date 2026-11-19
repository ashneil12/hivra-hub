// Ash (12 Nov): clicking a first mate (a Lead, the Chief of Staff) opens the chat he was last on with it, not always
// its first chat (which, with the list newest first, sits at the bottom). With no chat remembered, its newest opens.
import { sameProjectPath } from "../../projects/model/recents";
import { monoForSession, type Mono } from "./mono";

const LAST_CHAT_KEY = "monocode:mono-last-chat";

/** Where a first mate's chat was opened: on its own (Home, its team) or as its own chat for one project. */
export type MonoChatScope = { monoId: string; project?: string };

/** What the chat list knows of a chat: enough to find the newest one. */
export type MonoChatSummary = { id: string; updatedAt?: number; cwd?: string };

function scopeKey(monoId: string, project: string | undefined): string {
  return `${monoId}|${project ?? ""}`;
}

function readStore(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_CHAT_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") out[key] = value;
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  try {
    localStorage.setItem(LAST_CHAT_KEY, JSON.stringify(store));
  } catch {
    // The next click opens the newest chat instead; harmless.
  }
}

/** The chat a first mate's row opens by default: its main chat, or its own chat for the project. */
function defaultChat(mono: Mono, project: string | undefined): string | undefined {
  return project ? mono.projectSessions?.[project] : mono.sessionId;
}

/**
 * A first mate's chat is on screen: remember it as the one to come back to. A team chat's seat (a room conversation)
 * is not one of its own chats and is not remembered. `scope` is how the first mate was opened, so a further chat
 * opened from its Chief of Staff list in a project is remembered for that project.
 */
export function noteMonoChat(sessionId: string, scope?: MonoChatScope): void {
  const mono = monoForSession(sessionId);
  if (!mono) return;
  let project: string | undefined;
  const projectEntry = Object.entries(mono.projectSessions ?? {}).find(([, id]) => id === sessionId);
  if (projectEntry) project = projectEntry[0];
  else if (mono.sessionId === sessionId) project = undefined;
  else if (mono.chats?.includes(sessionId)) project = scope?.monoId === mono.id ? scope.project : undefined;
  else return;
  const store = readStore();
  const key = scopeKey(mono.id, project);
  if (store[key] === sessionId) return;
  store[key] = sessionId;
  writeStore(store);
}

/**
 * The chat to open for this first mate: the one Ash was last on (while it is still one of its chats), else its newest
 * chat in the list. Undefined: open its default chat, as before.
 */
export function pickMonoChat(
  mono: Mono,
  project: string | undefined,
  sessions: readonly MonoChatSummary[],
  folder?: string,
): string | undefined {
  const main = defaultChat(mono, project);
  const known = new Map(sessions.map((s) => [s.id, s]));
  const sideChats = (mono.chats ?? []).filter((id) => {
    const session = known.get(id);
    if (!session) return false;
    return !folder || !session.cwd || session.cwd === "~" || sameProjectPath(session.cwd, folder);
  });
  const remembered = readStore()[scopeKey(mono.id, project)];
  if (remembered && (remembered === main || sideChats.includes(remembered))) return remembered;
  let newest: MonoChatSummary | undefined = main ? (known.get(main) ?? { id: main, updatedAt: 0 }) : undefined;
  for (const id of sideChats) {
    const session = known.get(id)!;
    if (!newest || (session.updatedAt ?? 0) > (newest.updatedAt ?? 0)) newest = session;
  }
  return newest?.id;
}
