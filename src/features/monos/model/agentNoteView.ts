// How an agent-to-agent note reads on screen (PM's half of the notes; CoS's agentNotes.ts is the data). Pure, so the
// look can change without touching the events: the note's words split into parts, the one agent with a chat to open
// marked as the link, and notes landing together grouped so a burst shows as one line that expands.
import type { AgentNote } from "./agentNotes";

/** Notes this close together fold into one line (a Lead handing out three jobs at once). */
export const FOLD_MS = 2 * 60_000;

export type NotePart =
  /** An agent's name; `opens` is the chat it opens, when there is one. */
  | { kind: "name"; text: string; opens: string | null }
  | { kind: "text"; text: string };

/** "Lead messaged Worker", "Worker got stuck", "Worker reported to Lead", then the note's own line, if any. */
export function noteParts(note: AgentNote): { head: NotePart[]; line: string | undefined } {
  const name = (side: AgentNote["from"]): NotePart => ({
    kind: "name",
    text: side.name,
    opens: note.target && side.session === note.target ? note.target : null,
  });
  const head: NotePart[] =
    note.kind === "stuck"
      ? [name(note.from), { kind: "text", text: " got stuck" }]
      : note.kind === "reported"
        ? [name(note.from), { kind: "text", text: " reported to " }, name(note.to)]
        : [name(note.from), { kind: "text", text: " messaged " }, name(note.to)];
  return { head, line: note.line?.trim() || undefined };
}

/** The head as plain words ("Lead messaged Worker"). */
export function noteHead(note: AgentNote): string {
  return noteParts(note).head.map((p) => p.text).join("");
}

/**
 * Runs of notes that landed together, by index into `notes` (undefined: not a note): each run's first index maps to
 * its length; a note inside a run (not its first) maps to 0, so it isn't drawn on its own. A lone note maps to 1.
 */
export function noteRuns(notes: readonly (AgentNote | undefined)[]): Map<number, number> {
  const runs = new Map<number, number>();
  let start = -1;
  notes.forEach((note, i) => {
    const prev = i > 0 ? notes[i - 1] : undefined;
    if (note && prev && start >= 0 && note.at - prev.at <= FOLD_MS) {
      runs.set(start, runs.get(start)! + 1);
      runs.set(i, 0);
      return;
    }
    start = note ? i : -1;
    if (note) runs.set(i, 1);
  });
  return runs;
}

/** A folded run's one line: how many, then each head in order ("3 team notes: Lead messaged …, … got stuck"). */
export function foldedLine(notes: readonly AgentNote[]): string {
  return `${notes.length} team notes: ${notes.map(noteHead).join(", ")}`;
}
