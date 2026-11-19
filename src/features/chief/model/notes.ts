// WP-215: a first mate notes a call it settled. The chat id is the caller's, never a field it can set.

import { foldDecisionKey } from "../../hub/model/decisionKey";
import { redListCategory } from "../../autopilot/model/redList";

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
 * The row a note writes. `answeredBy` is this chat's note mark, not anything the caller typed
 * and not a captain. Free text is not an owner key: a red-list note is refused, and the store checks again.
 */
export function noteDecision(input: NoteInput): NotedDecision {
  const project = required(input.project, "The project");
  const what = required(input.what, "What was decided");
  const reason = required(input.reason, "The reason");
  const session = required(input.sessionId, "The chat");
  const raw = `${what}\n${reason}`;
  const folded = `${foldDecisionKey(what)}\n${foldDecisionKey(reason)}`;
  if (redListCategory(raw) || redListCategory(folded)) {
    throw new Error("This is on the red list, so a note cannot record it.");
  }
  return { project, session, what, reason, answeredBy: `note:${session}` };
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
