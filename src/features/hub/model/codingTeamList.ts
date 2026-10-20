// The coding team's Sessions list (Ash, 20 Oct): the project's Lead pinned at the top, Ash's own chats under it, and
// every chat a chat started (delegate_task, sessions.start) nested under the chat Ash talks to, like Claude Code's
// grouped sessions but folded away until one is stuck (monos/ui/SubChatList.tsx). Ash never talks to workers, so a
// worker's own workers join the same top-level chat.
import type { Delegation } from "../../monos/model/delegations";
import type { ChildChat } from "../../monos/model/delegationView";

/** A chat the list has: its id, title and when it began. */
export type ListedChat = { id: string; title: string; createdAt: number };

/**
 * The chat whose id this one starts with, among `known` (`app-<caller>-<request>`, and caller ids have hyphens too):
 * the longest such id. Undefined for a chat no listed chat started.
 */
function callerOf(id: string, known: ReadonlySet<string>): string | undefined {
  if (!id.startsWith("app-")) return undefined;
  const rest = id.slice(4);
  for (let at = rest.lastIndexOf("-"); at > 0; at = rest.lastIndexOf("-", at - 1)) {
    const candidate = rest.slice(0, at);
    if (candidate !== id && known.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Each top-level chat's sub-chats, by its id, newest first, and every chat that is one (so the list leaves them out of
 * its top level). From the delegation rows (who started each worker, and how it stands: working, asking, stuck, done)
 * and, for a chat started without a row (an /operator launch), its id alone, working while it is busy. A sub-chat of a
 * sub-chat joins the top-level chat above it. A top-level chat is never someone's sub-chat here, even when it is one
 * (a Lead's chat a leadership brief went into).
 */
export function subChatsByParent(
  parents: readonly string[],
  listed: readonly ListedChat[],
  rows: readonly Delegation[],
  busy: ReadonlySet<string>,
): { byParent: Map<string, ChildChat[]>; childIds: Set<string> } {
  const top = new Set(parents);
  const newest = new Map<string, Delegation>();
  for (const row of rows) {
    const known = newest.get(row.childSession);
    if (!known || row.createdAt > known.createdAt) newest.set(row.childSession, row);
  }
  const known = new Set<string>([...parents, ...listed.map((chat) => chat.id), ...newest.keys()]);
  const ownerOf = (id: string) => newest.get(id)?.ownerSession ?? callerOf(id, known);
  const rootOf = (id: string): string | undefined => {
    const seen = new Set([id]);
    for (let up = ownerOf(id); up && !seen.has(up); up = ownerOf(up)) {
      if (top.has(up)) return up;
      seen.add(up);
    }
    return undefined;
  };
  const byParent = new Map<string, ChildChat[]>();
  const childIds = new Set<string>();
  const add = (parent: string, chat: ChildChat) => {
    childIds.add(chat.sessionId);
    const list = byParent.get(parent);
    if (list) list.push(chat);
    else byParent.set(parent, [chat]);
  };
  for (const row of newest.values()) {
    if (top.has(row.childSession)) continue;
    const parent = rootOf(row.childSession);
    if (!parent) continue;
    add(parent, {
      sessionId: row.childSession,
      ownerSession: row.ownerSession,
      title: row.title?.trim() || listed.find((chat) => chat.id === row.childSession)?.title || "Delegated work",
      state: row.state,
      createdAt: row.createdAt,
      row,
    });
  }
  for (const chat of listed) {
    if (top.has(chat.id) || newest.has(chat.id)) continue;
    const parent = rootOf(chat.id);
    if (!parent) continue;
    add(parent, {
      sessionId: chat.id,
      ownerSession: ownerOf(chat.id) ?? parent,
      title: chat.title.trim() || "Started chat",
      state: busy.has(chat.id) ? "running" : "completed",
      createdAt: chat.createdAt,
    });
  }
  // Newest first, so the six shown are the latest (a stuck one always shows: subChats.ts shownSubChats).
  for (const list of byParent.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  return { byParent, childIds };
}

const VIEW_KEY = "monocode:coding-team-view";

/**
 * What a project's coding team opens on: its Lead's chat (the default, Ash, 20 Oct: the Lead is the coding team's
 * default chat), or the chat Ash was last in there.
 */
export function codingTeamView(projectId: string): "lead" | "chat" {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, unknown>;
    return saved[projectId] === "chat" ? "chat" : "lead";
  } catch {
    return "lead";
  }
}

export function noteCodingTeamView(projectId: string, view: "lead" | "chat"): void {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, unknown>;
    if (saved[projectId] === view) return;
    localStorage.setItem(VIEW_KEY, JSON.stringify({ ...saved, [projectId]: view }));
  } catch {
    /* it opens on the Lead again, the default */
  }
}
