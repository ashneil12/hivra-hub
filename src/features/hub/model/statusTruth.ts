// r103 (3, 4): what a Lead may call "done" and "running" when Ash asks how things stand, from the app rather than the
// Lead's memory. B5 0255: the badge asks were counted done although the worker's report said the red needs-you count
// and the macOS dock side were not fixed (4); after a restart the Lead said "the hub filing in progress" while the
// worker had reported back 3 minutes before the quit (3).
import type { Block, Session } from "../../sessions/model/session";

type ChatBlock = Pick<Block, "role" | "text"> & Partial<Pick<Block, "monoSessionCompletion" | "monoSpawnedSessions">>;

const clip = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : text);
const plain = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
/** A worker's words saying a part was not done. */
const NOT_DONE =
  /\b(?:not (?:touched|fixed|done|changed|built)|was(?:n't| not) (?:touched|fixed|done|changed)|cannot change|can(?:'|no)t change|needs? (?:the|a real) (?:lead|build)|left out|still wrong|lead-only)\b/i;

/** A worker report's text as written (a completion block may carry it JSON-escaped). */
function reportText(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\"/g, '"');
}

/**
 * The parts the Lead's workers said they did not do: their "Unsure:" line and each "Not in this change" item that says
 * it was not touched or needs someone else. Newest report last; at most eight.
 */
export function openPartsOf(blocks: readonly ChatBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (!b.monoSessionCompletion || b.monoSessionCompletion.question || !b.text) continue;
    const text = reportText(b.text);
    for (const line of text.split("\n")) {
      const t = plain(line.replace(/^[\s>*•-]+/, ""));
      if (!t || /^already there\b/i.test(t.replace(/^[^.]*\.\s*/, "")) && !NOT_DONE.test(t)) continue;
      const unsure = /^unsure:\s*(.+)$/i.exec(t);
      if (unsure && !/^(?:nothing|none)\b/i.test(unsure[1]!)) out.push(clip(`unsure: ${unsure[1]}`));
      else if (!unsure && NOT_DONE.test(t) && !/^#/.test(line.trim())) out.push(clip(t));
    }
  }
  return [...new Set(out)].slice(-8);
}

/** The Lead's workers still running, by title: the chats it started that are busy now. */
export function runningWorkers(blocks: readonly ChatBlock[], sessions: readonly Pick<Session, "id" | "busy" | "title">[]): string[] {
  const ids = new Map<string, string>();
  for (const b of blocks) for (const s of b.monoSpawnedSessions ?? []) ids.set(s.sessionId, s.title);
  return sessions.filter((s) => ids.has(s.id) && s.busy).map((s) => ids.get(s.id) || s.title || "a worker");
}

/** The wire note for a status question: what is running now, and the parts workers said are not done. */
export function statusTruthLine(running: readonly string[], openParts: readonly string[]): string {
  const run = running.length
    ? `Running right now, from the app: ${running.join("; ")}. Only these are "running"; anything else a worker already reported back is finished, never "in progress".`
    : `Nothing of yours is running right now, from the app: every worker you started has reported back or stopped. Never call anything "in progress" or "running", and leave "running" out of your count line.`;
  const open = openParts.length
    ? ` Your workers said these parts are NOT done: ${openParts.join(" | ")}. An ask with any part not done is not done: never count it under done; put it under parked (or blocked, if it needs his yes or pick) with what's left in one sentence.`
    : "";
  return `${run}${open}`;
}
