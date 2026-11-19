// The coding team's Sessions list (Ash, 20 Oct): the project's Lead pinned at the top, Ash's own chats under it, and
// every chat a chat started (delegate_task, sessions.start) nested under the chat Ash talks to, like Claude Code's
// grouped sessions but folded away until one is stuck (monos/ui/SubChatList.tsx). Ash never talks to workers, so a
// worker's own workers join the same top-level chat.
import { isOwed, type Delegation } from "../../monos/model/delegations";
import type { ChildChat } from "../../monos/model/delegationView";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { listTitle } from "../../../shared/text/plainTitle";

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
/** How long a finished, reported sub-chat stays in its chat's list before it counts as resolved. */
export const RESOLVED_SHOWN_MS = 24 * 60 * 60 * 1000;

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
  const resolvedBefore = Date.now() - RESOLVED_SHOWN_MS;
  for (const row of newest.values()) {
    if (top.has(row.childSession)) continue;
    // Ash 12 Nov: sub-chats piled up forever. One finished, reported and a day old is resolved: it leaves the list
    // (its line is in its Mono's memory, finishedWork.ts, and the chat itself stays, by id).
    if (!isOwed(row) && (row.settledAt ?? row.updatedAt) < resolvedBefore) {
      childIds.add(row.childSession);
      continue;
    }
    const parent = rootOf(row.childSession);
    if (!parent) continue;
    add(parent, {
      sessionId: row.childSession,
      ownerSession: row.ownerSession,
      // As a list shows a title (plainTitle.ts listTitle): no "claude · " label, no [MonoCode …] tag.
      title:
        listTitle(row.title ?? "") ||
        listTitle(listed.find((chat) => chat.id === row.childSession)?.title ?? "") ||
        "Delegated work",
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
      title: listTitle(chat.title) || "Started chat",
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

/**
 * The row a coding team's Lead renames as (Sidebar.tsx renderLeadCard): its chat, under the chat's own title, so F2 and
 * double-click rename the chat as any other (Ash, 22 Oct: the Hub lead's chat kept "QA test from the test run (D5, stuck
 * worker)" and nothing could rename it). None until its chat exists: the row's id is a stand-in then.
 */
export function leadRenameRow(lead: { session: SessionSummary; chatTitle?: string }): SessionSummary | undefined {
  if (lead.chatTitle === undefined || lead.session.id.startsWith("lead:")) return undefined;
  return { ...lead.session, title: lead.chatTitle };
}
