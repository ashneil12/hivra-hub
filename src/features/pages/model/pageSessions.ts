// A page reading Ash's chats (C4's "sessions"): the app's own list, which project each chat is working in and what was
// last said, in the same plain words the app uses. Read on ask (`sessions.read`), and behind `agents.read`: a page that
// may see the agents may see their chats, and no other page may. A chat's whole transcript is never handed over — only
// the last line, cut short — so a page can show “what is going on” without holding a copy of everything Ash said.
import { pathKey } from "../../../shared/lib/paths";
import type { HubProject } from "../../hub/model/types";
import type { Session, Block } from "../../sessions/model/session";
import type { SessionStateStore } from "../../sessions/model/sessionStateStore";
import type { BridgeHandlers } from "./bridge";

export type PageChat = {
  id: string;
  title: string;
  /** The project whose folder it works in, by name; null for any other chat. */
  project: string | null;
  harness: string;
  model: string;
  /** A turn is running right now. */
  working: boolean;
  /** When its last message was sent, or its running turn started (epoch ms), when known. */
  lastAt?: number;
  /** The last thing said, one short line. */
  lastLine?: string;
  lastBy?: "you" | "agent";
};

const MAX_LINE = 160;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Chats a page shouldn't see: the hub's own worker and habit runs, and anything the sidebar hides. */
function hidden(s: Session): boolean {
  return !!(
    s.ephemeral ||
    s.sidebarHidden ||
    s.orchestrationLeadId ||
    s.inboxAsk ||
    (s as Session & { automationId?: string }).automationId
  );
}

function projectOf(s: Session, projects: readonly HubProject[]): HubProject | undefined {
  if (!s.cwd) return undefined;
  const key = pathKey(s.cwd);
  return projects.find((p) => !!p.folder && pathKey(p.folder) === key);
}

function line(b: Block | undefined): { text: string; by: "you" | "agent" } | undefined {
  if (!b) return undefined;
  const text = (b.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return { text: text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text, by: b.role === "user" ? "you" : "agent" };
}

function lastOf(s: Session): { at?: number; said?: { text: string; by: "you" | "agent" } } {
  let at: number | undefined;
  let said: { text: string; by: "you" | "agent" } | undefined;
  for (let i = s.blocks.length - 1; i >= 0; i--) {
    const b = s.blocks[i];
    if (at === undefined && typeof b.startedAt === "number") at = b.startedAt;
    if (!said) said = line(b);
    if (at !== undefined && said) break;
  }
  return { at, said };
}

/** What a page sees of Ash's chats: newest first, one project's when asked. */
export function sessionsData(
  sessions: readonly Session[],
  projects: readonly HubProject[],
  args: { projectId?: unknown; limit?: unknown } = {},
): { sessions: PageChat[]; total: number } {
  const wanted = typeof args.projectId === "string" && args.projectId ? args.projectId : undefined;
  const project = wanted
    ? projects.find((p) => p.id === wanted || p.name.toLowerCase() === wanted.toLowerCase())
    : undefined;
  if (wanted && !project) throw new Error(`There's no project called “${wanted}”.`);
  const limit = Math.min(MAX_LIMIT, Math.max(1, typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT));

  const rows: PageChat[] = [];
  for (const s of sessions) {
    if (hidden(s)) continue;
    const own = projectOf(s, projects);
    if (project && own?.id !== project.id) continue;
    const { at, said } = lastOf(s);
    rows.push({
      id: s.id,
      title: s.title.trim() || "Untitled chat",
      project: own?.name ?? null,
      harness: s.harness,
      model: s.model,
      working: !!s.busy,
      ...(at !== undefined ? { lastAt: at } : {}),
      ...(said ? { lastLine: said.text, lastBy: said.by } : {}),
    });
  }
  rows.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  return { sessions: rows.slice(0, limit), total: rows.length };
}

type Sessions = Pick<SessionStateStore, "snapshot"> | null;

/** The bridge handler for `sessions.read`: the app's chats, as they are when asked. */
export function pageSessionsHandlers(sessions: Sessions, projects: () => readonly HubProject[]): BridgeHandlers {
  return {
    "sessions.read": async (args) =>
      sessions
        ? sessionsData(sessions.snapshot(), projects(), args)
        : { sessions: [], total: 0 },
  };
}
