// Ash, 12 Nov: "subchats need to be better set up so they actually go somewhere where things are resolved", and one
// main chat should be able to go on forever with enough memory to carry on in any new chat. So when a Mono's worker
// finishes and its report has reached the Mono, one line about it goes into the Mono's own memory
// (memory/finished-work.md, a standing note: loaded in full on every handover, monoFiles.ts STANDING_NOTES). The
// sub-chat itself then folds away (SubChatList "N finished") and drops out of the lists a day later
// (codingTeamList.ts), while the Mono still knows what was done, how it ended and which chat holds the detail.
import type { Delegation } from "./delegations";
import { isOwed } from "./delegations";
import { readAgentFile, writeAgentFile, MonoFileConflict } from "./monoFiles";

export const FINISHED_WORK_NOTE = "finished-work";
const PATH = `memory/${FINISHED_WORK_NOTE}.md` as const;
/** Newest first; past this the oldest lines go (the chats themselves stay, by id). */
export const FINISHED_WORK_MAX_LINES = 60;
/** A row settled longer ago than this when the app first sees it is history, not news: it is not logged. */
const FRESH_MS = 24 * 60 * 60 * 1000;

const HEADER = `# Finished work

Your workers' finished jobs, newest first, written by the app when each report reached you. Check here before redoing
work or when Ash asks what happened. The chat id opens the worker's whole chat (sessions.read).
`;

function oneLine(text: string | null | undefined, max: number): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function outcomeOf(row: Pick<Delegation, "state">): string {
  return row.state === "completed" ? "done" : row.state === "failed" ? "failed" : "stopped";
}

/** The marker that makes a line this row's (so it is written once). */
export function finishedWorkMarker(row: Pick<Delegation, "id">): string {
  return `[job ${row.id}]`;
}

/** One line for a finished job: when, what, how it ended, what it said, where its chat is. */
export function finishedWorkLine(row: Delegation): string {
  const day = new Date(row.settledAt ?? row.updatedAt).toISOString().slice(0, 10);
  const said = oneLine(row.result ?? row.error ?? row.statusNotice, 220);
  const title = oneLine(row.title, 90) || "Delegated work";
  return `- ${day} · ${title} · ${outcomeOf(row)}${said ? ` · ${said}` : ""} · chat ${row.childSession} ${finishedWorkMarker(row)}`;
}

/** The note with this line added on top (once), capped. */
export function withFinishedWork(text: string | null | undefined, row: Delegation): string {
  const marker = finishedWorkMarker(row);
  const lines = (text ?? "").split("\n").filter((line) => line.startsWith("- "));
  if (lines.some((line) => line.includes(marker))) return text ?? "";
  const kept = [finishedWorkLine(row), ...lines].slice(0, FINISHED_WORK_MAX_LINES);
  return `${HEADER}\n${kept.join("\n")}\n`;
}

/** A finished job worth a line: its Mono is known, it is settled, its report has reached the Mono, and it is recent. */
export function finishedWorkDue(row: Delegation, now: number): boolean {
  if (!row.ownerMono || isOwed(row)) return false;
  if (row.state !== "completed" && row.state !== "failed" && row.state !== "cancelled") return false;
  return (row.settledAt ?? row.updatedAt) >= now - FRESH_MS;
}

/** Writes the line into the Mono's memory, once; a save that raced another is tried again. */
export async function logFinishedWork(row: Delegation): Promise<boolean> {
  const monoId = row.ownerMono;
  if (!monoId) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readAgentFile(monoId, PATH).catch(() => ({ text: null, hash: "" }));
    const next = withFinishedWork(current.text, row);
    if (next === (current.text ?? "")) return false;
    try {
      await writeAgentFile(monoId, PATH, next, current.hash || undefined);
      return true;
    } catch (error) {
      if (!(error instanceof MonoFileConflict)) return false;
    }
  }
  return false;
}
