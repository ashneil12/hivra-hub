// WP-215: a first mate notes a call it settled. The chat id is the caller's, never a field it can set.

import { isOwnerKey } from "./captain";

export type NoteInput = {
  project: string;
  what: string;
  reason: string;
  sessionId: string;
};

export type NotedDecision = {
  project: string;
  session: string;
  what: string;
  reason: string;
  answeredBy: string;
};

function required(value: string, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is empty.`);
  return text;
}

/**
 * The row a note writes. `answeredBy` is this chat, not anything the caller typed.
 * A person-only key is refused here too; the store refuses it again.
 */
export function noteDecision(input: NoteInput): NotedDecision {
  const project = required(input.project, "The project");
  const what = required(input.what, "What was decided");
  const reason = required(input.reason, "The reason");
  const session = required(input.sessionId, "The chat");
  if (isOwnerKey(what)) throw new Error("Only the owner answers this. A note cannot.");
  return { project, session, what, reason, answeredBy: `chat:${session}` };
}

export type NoteWriter = (row: NotedDecision) => Promise<unknown>;

let writer: NoteWriter | null = null;

/** Tests pass their own writer. The app uses the decision store. */
export function setNoteWriter(next: NoteWriter | null): void {
  writer = next;
}

async function defaultWriter(row: NotedDecision): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("decisions_note", { project: row.project, session: row.session, what: row.what, reason: row.reason });
}

export async function recordNote(input: NoteInput): Promise<unknown> {
  const row = noteDecision(input);
  return (writer ?? defaultWriter)(row);
}
