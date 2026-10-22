// How an agent-to-agent note reads on screen (PM's half of the notes; CoS's agentNotes.ts is the data). Pure, so the
// look can change without touching the events: the note's words split into parts, the one agent with a chat to open
// marked as the link, and notes landing together grouped so a burst shows as one line that expands.
import { stoppedWords, type AgentNote } from "./agentNotes";

/** Notes this close together fold into one line (a Lead handing out three jobs at once). */
export const FOLD_MS = 2 * 60_000;

export type NotePart =
  /** An agent's name; `opens` is the chat it opens, when there is one. */
  | { kind: "name"; text: string; opens: string | null }
  | { kind: "text"; text: string };

/** "Lead messaged Worker", "Worker is with Hivra lead", "Worker reported to Lead", then the note's own line, if any. */
export function noteParts(note: AgentNote): { head: NotePart[]; line: string | undefined } {
  const name = (side: AgentNote["from"]): NotePart => ({
    kind: "name",
    text: side.name,
    opens: note.target && side.session === note.target ? note.target : null,
  });
  const head: NotePart[] =
    note.kind === "stuck"
      ? note.owner === "needs-you" || note.owner === "retrying"
        ? [name(note.from), { kind: "text", text: stoppedWords(note) }]
        : [name(note.from), { kind: "text", text: " is with " }, name(note.to)]
      : note.kind === "reported"
        ? [name(note.from), { kind: "text", text: " reported to " }, name(note.to)]
        : [name(note.from), { kind: "text", text: " messaged " }, name(note.to)];
  return { head, line: detailOf(note) };
}

/** What a worker's label says about its task: `Worker "Fix the login page"` → `Fix the login page`. */
function labelTask(name: string): string | undefined {
  return name.match(/"(.+)"\s*$/)?.[1]?.trim();
}

const same = (a: string) => a.replace(/[\s.…]+$/, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The note's detail, unless it only says again what a name already says: a Lead handing Worker "Fix the login page"
 * its job has the brief's first line as the detail, which is that same label (cut short or not), so it is left off.
 */
export function detailOf(note: AgentNote): string | undefined {
  const line = note.line?.trim();
  if (!line) return undefined;
  const d = same(line);
  for (const side of [note.from, note.to]) {
    const task = labelTask(side.name);
    if (!task) continue;
    const t = same(task);
    // The label is cut at 60 characters ("…"), the line at 140: one starting with the other is the same task.
    if (t === d || (task.endsWith("…") && d.startsWith(t)) || (line.endsWith("…") && t.startsWith(d))) return undefined;
  }
  return line;
}

/** The note in plain words as it reads on screen (what a screen reader hears too). */
export function noteText(note: AgentNote): string {
  const line = detailOf(note);
  return line ? `${noteHead(note)}: ${line}` : noteHead(note);
}

/** A note that must be seen on its own: a worker that got stuck never folds away with routine notes. */
export function standsAlone(note: AgentNote): boolean {
  return note.kind === "stuck";
}

/** The head as plain words ("Lead messaged Worker"). */
export function noteHead(note: AgentNote): string {
  return noteParts(note).head.map((p) => p.text).join("");
}

/**
 * Runs of notes that landed together, by index into `notes` (undefined: not a note): each run's first index maps to
 * its length; a note inside a run (not its first) maps to 0, so it isn't drawn on its own. A lone note maps to 1.
 * A stuck note (standsAlone) is always its own run of 1 and ends the run before it: routine notes either side of it
 * fold on their own, it never folds.
 */
export function noteRuns(notes: readonly (AgentNote | undefined)[]): Map<number, number> {
  const runs = new Map<number, number>();
  let start = -1;
  notes.forEach((note, i) => {
    const prev = i > 0 ? notes[i - 1] : undefined;
    if (note && prev && start >= 0 && !standsAlone(note) && !standsAlone(prev) && note.at - prev.at <= FOLD_MS) {
      runs.set(start, runs.get(start)! + 1);
      runs.set(i, 0);
      return;
    }
    start = note ? i : -1;
    if (note) runs.set(i, 1);
  });
  return runs;
}

/** A folded run's one line: just how many ("3 team notes"); what they say shows only once it's opened. */
export function foldedLine(notes: readonly AgentNote[]): string {
  return `${notes.length} team notes`;
}
