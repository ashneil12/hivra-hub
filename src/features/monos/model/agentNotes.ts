// Agent-to-agent notes in a chat (Ash, 21 Oct 20:45): what agents say to each other shows inline, as small notes in the
// chat that owns the work, not in a log. "Lead messaged Worker X", "Worker X messaged Lead", "Worker X got stuck",
// "Worker X reported". A note opens that agent's chat when one exists; with none, it is plain text (no dead link).
//
// Data side only (CoS); PM owns the look (ui/AgentNoteRow.tsx is a plain default to restyle). Fed by the delegation
// rows the app already keeps (delegate_task, a worker's question, the stall watcher, a failure, the report-back): one
// typed event per move, carried on a system Block as `agentNote`. Shape documented in docs/hub/README.md.
import type { Block } from "../../sessions/model/session";
import type { Delegation } from "./delegations";
import { storedQuestion, stuckOf } from "./workerStuck";

export type AgentNoteKind = "messaged" | "stuck" | "reported";

/** One side of a note: the chat (session id) and how the note names it. */
export type AgentNoteParty = { session: string; name: string };

export type AgentNote = {
  kind: AgentNoteKind;
  from: AgentNoteParty;
  to: AgentNoteParty;
  /** The chat the note opens: a session id, or null when that chat doesn't exist (the note shows without a link). */
  target: string | null;
  /** The task (delegation row id) it is about. */
  taskId: string;
  /** When it happened, epoch ms. */
  at: number;
  /** One short line: the brief's first line, the question, why it is stuck, or the report's first line. */
  line?: string;
};

const firstLine = (text: string | null | undefined, max = 140): string | undefined => {
  const line = (text ?? "").trim().split("\n").find((l) => l.trim())?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max).replace(/\s+\S*$/, "")}…` : line;
};

/** How a note names the two sides of a row: its owner (the Lead, or the chat that delegated) and its worker. */
export type NoteNames = { owner: string; worker: string };

export function defaultNoteNames(row: Pick<Delegation, "ownerMono" | "title">): NoteNames {
  const title = row.title?.trim();
  return { owner: row.ownerMono ? "Lead" : "Chat", worker: title ? `Worker "${firstLine(title, 60)}"` : "Worker" };
}

/**
 * Every note a row has made so far, oldest first: the owner messaged the worker (delegated), the worker messaged its
 * owner (a question), it got stuck (stalled or failed), it reported (done). `exists` says whether a chat is there to
 * open; a worker whose chat is gone gets notes without a link.
 */
export function agentNotesFor(
  row: Delegation,
  now: number,
  exists: (session: string) => boolean,
  names: NoteNames = defaultNoteNames(row),
): AgentNote[] {
  const owner = { session: row.ownerSession, name: names.owner };
  const worker = { session: row.childSession, name: names.worker };
  const target = exists(row.childSession) ? row.childSession : null;
  const base = { taskId: row.id, target };
  const notes: AgentNote[] = [
    { ...base, kind: "messaged", from: owner, to: worker, at: row.createdAt, line: firstLine(row.title) },
  ];
  const stuck = stuckOf(row, now);
  if (stuck?.kind === "asking")
    notes.push({ ...base, kind: "messaged", from: worker, to: owner, at: stuck.since, line: firstLine(storedQuestion(row.pendingQuestion).text) });
  else if (stuck) notes.push({ ...base, kind: "stuck", from: worker, to: owner, at: stuck.since, line: firstLine(stuck.line) });
  if (row.state === "completed")
    notes.push({ ...base, kind: "reported", from: worker, to: owner, at: row.settledAt ?? row.updatedAt, line: firstLine(row.result) });
  return notes;
}

/** The note in plain words (the Block's text, and what a screen reader hears). */
export function agentNoteText(note: AgentNote): string {
  const head =
    note.kind === "stuck"
      ? `${note.from.name} got stuck`
      : note.kind === "reported"
        ? `${note.from.name} reported to ${note.to.name}`
        : `${note.from.name} messaged ${note.to.name}`;
  return note.line ? `${head}: ${note.line}` : head;
}

/** Stable per move, so a note is never added twice. */
export function agentNoteId(note: AgentNote): string {
  return `agent-note-${note.taskId}-${note.kind}-${note.at}-${note.from.session.slice(-24)}`.slice(0, 200);
}

export function agentNoteBlock(note: AgentNote): Block {
  return { id: agentNoteId(note), role: "system", text: agentNoteText(note), agentNote: note };
}

/**
 * The notes to add now, each to the chat that owns the work: moves since `since` (this run of the app; older history
 * isn't replayed into a chat), not already in that chat or in `added`.
 */
export function newAgentNoteBlocks(
  rows: readonly Delegation[],
  chats: readonly { id: string; blocks: readonly Pick<Block, "id">[] }[],
  since: number,
  now: number,
  exists: (session: string) => boolean,
  added: ReadonlySet<string> = new Set(),
): { chatId: string; block: Block }[] {
  const out: { chatId: string; block: Block }[] = [];
  for (const row of rows) {
    const chat = chats.find((c) => c.id === row.ownerSession);
    if (!chat) continue;
    for (const note of agentNotesFor(row, now, exists)) {
      if (note.at < since) continue;
      const block = agentNoteBlock(note);
      if (added.has(block.id) || chat.blocks.some((b) => b.id === block.id)) continue;
      out.push({ chatId: chat.id, block });
    }
  }
  return out.sort((a, b) => (a.block.agentNote!.at - b.block.agentNote!.at));
}
