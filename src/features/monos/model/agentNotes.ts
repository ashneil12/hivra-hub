// Agent-to-agent notes in a chat (Ash, 21 Oct 20:45): what agents say to each other shows inline, as small notes in the
// chat that owns the work, not in a log. "Lead messaged Worker X", "Worker X messaged Lead", "Worker X is with Hivra lead",
// "Worker X reported". A note opens that agent's chat when one exists; with none, it is plain text (no dead link).
//
// Data side only (CoS); PM owns the look (ui/AgentNoteRow.tsx is a plain default to restyle). Fed by the delegation
// rows the app already keeps (delegate_task, a worker's question, the stall watcher, a failure, the report-back): one
// typed event per move, carried on a system Block as `agentNote`. Shape documented in docs/hub/README.md.
import type { Block } from "../../sessions/model/session";
import type { Delegation } from "./delegations";
import { findMono } from "./mono";
import { storedQuestion, stuckOf, stuckOwner, type StuckOwner } from "./workerStuck";

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
  /**
   * A stopped worker's note (kind `stuck`): whose it is under the red rule (r30b; workerStuck.ts stuckOwner): its Lead's,
   * a retry's, or Ash's (a billing or sign-in refusal). Missing on notes made before r30b: read as its Lead's.
   */
  owner?: StuckOwner;
  /** r91: a worker's question to its owner (kind `messaged`), said "asked", not "messaged". */
  ask?: true;
};

/**
 * r91 (Critiquito: "Chat messaged Worker …" read like a log): what a `messaged` note says between the two names.
 * The owner handing out the job is " handed a job to "; a worker's question is " asked ".
 */
export function messagedWords(note: Pick<AgentNote, "ask">): string {
  return note.ask ? " asked " : " handed a job to ";
}

const firstLine = (text: string | null | undefined, max = 140): string | undefined => {
  const line = (text ?? "").trim().split("\n").find((l) => l.trim())?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max).replace(/\s+\S*$/, "")}…` : line;
};

/**
 * A finished job's one-line summary (r79, c02: "results came back as a truncated worker paste"): the result's first
 * sentence in plain words, markdown and list marks off, a trailing colon (a paste's lead-in) dropped, cut at a word.
 */
export const summaryLine = (text: string | null | undefined, max = 100): string | undefined => {
  // r87 (c02 run 1, "a raw land blob"): the app's own [MonoCode landed] line is for the Lead; the note says it plainly.
  const tag = (text ?? "").match(/^\s*\[MonoCode (not )?landed\][^\n]*\n*/);
  if (tag) {
    const rest = summaryLine((text ?? "").slice(tag[0].length), max);
    const said = tag[1] ? "Not in the project yet" : "In the project";
    return rest ? `${said}. ${rest}` : `${said}.`;
  }
  const plain = (text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>|]/g, "");
  const line = plain
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim())
    .find((l) => l);
  if (!line) return undefined;
  const sentence = (line.match(/^(.+?[.!?])(?=\s|$)/)?.[1] ?? line).replace(/\s*[:;,]$/, "");
  return sentence.length > max ? `${sentence.slice(0, max).replace(/\s+\S*$/, "")}…` : sentence;
};

/** How a note names the two sides of a row: its owner (the Lead, or the chat that delegated) and its worker. */
export type NoteNames = { owner: string; worker: string };

/**
 * The owner is named as itself: the Mono's own name ("Alfred", "MonoCode Hub lead"), never "Lead" for a Mono that
 * isn't one (22 Oct: Alfred's own team read "Lead messaged Worker"). "Lead" only when the Mono can't be found.
 */
export function defaultNoteNames(
  row: Pick<Delegation, "ownerMono" | "title">,
  monoName: (id: string) => string | undefined = (id) => findMono(id)?.name,
): NoteNames {
  const title = row.title?.trim();
  const owner = row.ownerMono ? monoName(row.ownerMono)?.trim() || "Lead" : "This chat";
  return { owner, worker: title ? `Worker "${firstLine(title, 60)}"` : "Worker" };
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
    notes.push({ ...base, kind: "messaged", ask: true, from: worker, to: owner, at: stuck.since, line: firstLine(storedQuestion(row.pendingQuestion).text) });
  else if (stuck)
    notes.push({ ...base, kind: "stuck", from: worker, to: owner, at: stuck.since, line: firstLine(stuck.line), owner: stuckOwner(stuck) });
  if (row.state === "completed")
    notes.push({ ...base, kind: "reported", from: worker, to: owner, at: row.settledAt ?? row.updatedAt, line: summaryLine(row.result) });
  return notes;
}

/**
 * What a stopped worker's note says after its name, under the red rule (r30b): " is with Hivra lead" or " is retrying"
 * in grey, " needs you" only when Ash must act. Never "got stuck".
 */
export function stoppedWords(note: Pick<AgentNote, "owner" | "to">): string {
  if (note.owner === "needs-you") return " needs you";
  if (note.owner === "retrying") return " is retrying";
  return ` is with ${note.to.name}`;
}

const SERVICE_STALL = /^Stalled: the AI service (.+?)\.(\s+Retrying didn't help\.)?\s*$/i;

/**
 * r97 (Critiquito c, r95): a worker stalled on its AI service reads as one sentence about it, never "Worker "X" is
 * with This chat: Stalled: …": ` stalled. The AI service stopped answering, and retrying didn't help.`
 */
export function serviceStallWords(note: Pick<AgentNote, "kind" | "line">): string | undefined {
  const m = note.kind === "stuck" ? SERVICE_STALL.exec(note.line?.trim() ?? "") : null;
  if (!m) return undefined;
  return ` stalled. The AI service ${m[1]}${m[2] ? ", and retrying didn't help" : ""}.`;
}

/** The note in plain words (the Block's text, and what a screen reader hears). */
export function agentNoteText(note: AgentNote): string {
  const stall = serviceStallWords(note);
  if (stall) return `${note.from.name}${stall}`;
  const head =
    note.kind === "stuck"
      ? `${note.from.name}${stoppedWords(note)}`
      : note.kind === "reported"
        ? `${note.from.name.match(/"(.+)"\s*$/)?.[1]?.trim() ?? note.from.name} is back`
        : `${note.from.name}${messagedWords(note)}${note.to.name}`;
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
