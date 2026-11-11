// Which live chats belong on the Agents board. A chat that is none of these is left off.

import type { StoreSession } from "./fromStores";

export type LiveChat = {
  id: string;
  title?: string | null;
  busy?: boolean;
  blocks?: readonly { startedAt?: number | null }[];
};

function firstStart(blocks: readonly { startedAt?: number | null }[]): number | null {
  for (const block of blocks) {
    if (typeof block.startedAt === "number") return block.startedAt;
  }
  return null;
}

function parentWorker(id: string, childSessions: readonly string[]): string | null {
  if (!id.startsWith("app-")) return null;
  let best: string | null = null;
  for (const child of childSessions) {
    if (id.startsWith(`app-${child}-`) && (!best || child.length > best.length)) best = child;
  }
  return best;
}

/**
 * Project chats, the sub-chats under a worker, and the Chief of Staff's chat on Home.
 * The home chat wins when a folder note would otherwise call it a project chat.
 */
export function liveBoardSessions(input: {
  sessions: readonly LiveChat[];
  childSessionIds: readonly (string | null | undefined)[];
  projectOfChat: (id: string) => string | undefined;
  homeSessionId?: string | null;
}): StoreSession[] {
  const childSessions = input.childSessionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  const homeId = (input.homeSessionId ?? "").trim();
  const out: StoreSession[] = [];
  const seen = new Set<string>();
  for (const session of input.sessions) {
    if (!session?.id || seen.has(session.id)) continue;
    const startedAt = firstStart(session.blocks ?? []);
    const status = session.busy ? "working" : "idle";
    if (homeId && session.id === homeId) {
      seen.add(session.id);
      out.push({
        id: session.id,
        place: "home",
        title: session.title,
        status,
        startedAt,
      });
      continue;
    }
    if (childSessions.includes(session.id)) continue;
    const projectId = input.projectOfChat(session.id);
    if (projectId) {
      seen.add(session.id);
      out.push({
        id: session.id,
        place: "project",
        projectId,
        title: session.title,
        status,
        startedAt,
      });
      continue;
    }
    const parent = parentWorker(session.id, childSessions);
    if (!parent) continue;
    seen.add(session.id);
    out.push({
      id: session.id,
      place: "subchat",
      parentSessionId: parent,
      title: session.title,
      status,
      startedAt,
    });
  }
  return out;
}
