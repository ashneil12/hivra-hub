// SC-19 (never lose an ask, gap D1: formal/asks/README.md): when a chat that owns open work is reset, archived or deleted,
// that work moves to the chat that takes its place, so the reports it owes still arrive. The store move is
// src-tauri/src/delegations/reparent.rs (one transaction); DelegationTracker.reparent keeps this window in step. This file
// is the app's side of it: which chat takes the work, the one note the new chat gets, and a move that is tried again.
import type { QueuedMessage } from "../../sessions/model/session";
import type { Delegation, DelegationTracker, Reparented } from "./delegations";

export type RetireKind = "reset" | "archive" | "delete";

/** The tag of the one app note a chat gets when work moved to it (sessions/model/appNote.ts shows it as a plain line). */
export const MOVED_TASKS_PREFIX = "[MonoCode moved tasks]";

const LIST_MAX = 12;
const TITLE_MAX = 80;

/** A title as one plain line: runs of spaces become one, dashes that read as an em-dash become a hyphen, a long one is cut. */
function titleLine(title: string | null | undefined): string {
  const line = (title ?? "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (!line) return "a task";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

const STATUS_WORDS = {
  working: "working",
  "needs-you": "waiting on you",
  done: "finished",
  failed: "failed",
  paused: "paused",
} as const;

/**
 * Where a moved row stands, in plain words: the row's own status (WP-10: read, never worked out here), and for a
 * finished row whose report is still owed, that the report is on its way. A worker that went quiet still reads as
 * working: the note is not a verdict, and a stall's own line is not repeated in it.
 */
export function movedStatus(row: Pick<Delegation, "status" | "state" | "delivery">): string {
  const open = row.state === "running" || row.state === "question";
  const word = STATUS_WORDS[row.status ?? (open ? "working" : "done")] ?? "working";
  const owed = !open && (row.delivery === "pending" || row.delivery === "queued");
  return owed ? `${word}, report on its way` : word;
}

/** A short stable hash, so the same move always has the same note id (a repeat is deduplicated by the queue). */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const CAUSE: Record<RetireKind, string> = {
  reset: "this chat was reset",
  archive: "the chat that owned them was archived",
  delete: "the chat that owned them was deleted",
};

/**
 * The one app note the new chat gets, listing what moved to it: "These tasks were still going when this chat was reset:
 * <title>: <status>, ...". Nothing moved, nothing said: a chat with no open work gets no note.
 */
export function movedWorkNote(input: {
  kind: RetireKind;
  moved: Reparented;
  /** The chat that took the work. */
  chatId: string;
}): QueuedMessage | undefined {
  const { moved } = input;
  const items = [
    ...moved.rows.map((row) => `${titleLine(row.title)}: ${movedStatus(row)}`),
    ...moved.waiting.map((job) => `${titleLine(job.title)}: waiting for a free worker`),
  ];
  if (!items.length) return undefined;
  const shown = items.slice(0, LIST_MAX);
  const more = items.length - shown.length;
  const list = shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
  const ids = [...moved.rows.map((row) => row.id), ...moved.waiting.map((job) => job.id)].sort();
  return {
    id: `moved-tasks-${input.chatId}-${digest(ids.join("\u0000"))}`,
    attachments: [],
    waitForIdle: true,
    text:
      `${MOVED_TASKS_PREFIX} From the app: These tasks were still going when ${CAUSE[input.kind]}: ${list}. ` +
      "Nothing was stopped. Their reports will arrive in this chat. This is an app notification, not a new message.",
  };
}

/** What the app knows when it picks the chat that takes a retired chat's work. */
export type SuccessorHost = {
  /** The Mono is still on the roster. */
  monoExists(monoId: string): boolean;
  /** The Mono's main chat, when it has one. */
  mainChat(monoId: string): string | undefined;
  /** The Lead a project has (the project is its folder) and the Lead's main chat. */
  leadChat(project: string): { monoId: string; chatId: string } | undefined;
};

/**
 * Which chat takes the work of a chat that is archived or deleted: the same first mate's main chat, when it has another;
 * else, for a deleted chat (its first mate has no chat left to hold it, or is gone), the main chat of its project's
 * Lead. An archived chat can come back where it was, so it only ever hands its work to the first mate's main chat.
 * None when no chat can take it: the work is left as it was (boot recovery then reports it cancelled, as before),
 * never given to a chat that can't hold it. A reset needs no pick: the fresh chat takes the work.
 */
export function ownerSuccessor(
  retired: { chatId: string; kind: Exclude<RetireKind, "reset">; monoId?: string; project?: string },
  host: SuccessorHost,
): { chatId: string; monoId: string } | undefined {
  const { monoId } = retired;
  if (monoId && host.monoExists(monoId)) {
    const main = host.mainChat(monoId);
    if (main && main !== retired.chatId) return { chatId: main, monoId };
  }
  if (retired.kind === "archive") return undefined;
  const project = retired.project?.trim();
  const lead = project ? host.leadChat(project) : undefined;
  if (lead && lead.chatId !== retired.chatId && lead.monoId !== monoId) return lead;
  return undefined;
}

/** How long to wait before each further try of a move the store refused (a busy database is not a final failure). */
export const MOVE_RETRY_MS = [0, 300, 1_500] as const;

/**
 * Move a retired chat's work to its successor and tell the successor once. A failed move is tried again, further apart
 * each time (the store's move is all or nothing and compare-and-swap, so a retry never moves anything twice); the last
 * failure is thrown. `post` puts the app note in the successor's queue.
 */
export async function moveOwnedWork(args: {
  tracker: Pick<DelegationTracker, "reparent">;
  kind: RetireKind;
  from: { chatId: string; title?: string };
  to: { chatId: string; monoId?: string };
  post: (chatId: string, message: QueuedMessage) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Reparented> {
  const { tracker, kind, from, to, post } = args;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let failure: unknown;
  for (const wait of MOVE_RETRY_MS) {
    if (wait) await sleep(wait);
    try {
      return await tracker.reparent(
        {
          from: from.chatId,
          to: to.chatId,
          ...(to.monoId ? { toMono: to.monoId } : {}),
          ...(from.title ? { fromTitle: from.title } : {}),
          why: kind,
        },
        async (moved) => {
          const note = movedWorkNote({ kind, moved, chatId: to.chatId });
          if (note) await post(to.chatId, note);
        },
      );
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
