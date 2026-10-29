// Coding with a Lead (Ash, 20 Oct: "a good chat and delegate if needed as per the orchestrator stuff and still chat"):
// what a Lead's chat shows while work it delegated runs.
// - `workingLine`: "2 working: API, UI" above the composer, so Ash sees what is out while he and the Lead talk.
// - `stillRunningNote`: borrowed from Block's Buzz. A Lead that ends a turn saying the job is done while work it
//   delegated is still out gets a visible "Still running: N" note in its chat, and the brief it works on stays open
//   (followedBriefs.ts waits for every worker). D5: the claim is checked against what the workers actually did, not
//   trusted — a worker that failed, or said it cannot finish, is named in the same note ("Not finished: …"), so a Lead
//   cannot report done over work that did not come back. It never holds the Lead or starts a turn: once per task, once
//   per brief.
import { isPreparingHandoff } from "../../sessions/model/handoff";
import type { Block, Session } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation } from "./delegations";
import { unfinishedWorker } from "./workerStuck";

/** A worker as the Lead's chat names it. */
function taskName(row: Pick<Delegation, "title">): string {
  return row.title?.trim().split("\n")[0].slice(0, 60) || "a worker";
}

/** "API, UI" (at most three names, then "+2"). */
function names(list: readonly string[]): string {
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} +${list.length - 3}` : list.join(", ");
}

/** What a chat has out right now: the tasks it delegated that still run, and the ones asking it a question. */
export function workingOn(
  ownerSession: string,
  rows: readonly Delegation[],
): { working: string[]; asking: string[] } {
  const own = rows
    .filter((row) => row.ownerSession === ownerSession && isOpenDelegation(row))
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    working: own.filter((row) => row.state === "running").map(taskName),
    asking: own.filter((row) => row.state === "question").map(taskName),
  };
}

/** "2 working: API, UI · 1 waiting: Docs", or nothing when nothing is out. */
export function workingLine(out: { working: readonly string[]; asking: readonly string[] }): string | undefined {
  const parts = [
    ...(out.working.length ? [`${out.working.length} working: ${names(out.working)}`] : []),
    ...(out.asking.length ? [`${out.asking.length} waiting: ${names(out.asking)}`] : []),
  ];
  return parts.length ? parts.join(" · ") : undefined;
}

/** Says the job is finished. */
const DONE = [
  /\b(?:all|everything)(?: is| are|'s)?(?: now)? (?:done|finished|complete|completed|shipped|merged|landed|wrapped up|in place)\b/,
  /\b(?:job|task|work|brief|feature|fix|change|request|project)s? (?:is|are|has been|have been|was)(?: now)?(?: all)? (?:done|finished|complete|completed|shipped|merged|landed)\b/,
  /\b(?:it'?s|that'?s|we'?re|i'?m)(?: all)? (?:done|finished|complete)\b/,
  /^\W*(?:done|finished|all done|all set|complete|shipped)\b/,
  /\bnothing (?:left|else|more|further) (?:to do|outstanding|pending|open)\b/,
  /\b(?:fully|successfully) (?:done|finished|completed|implemented|shipped)\b/,
];
/** Says some of it still runs, or what comes next: not a claim that it is all done. */
const STILL =
  /\b(?:still|currently) (?:running|working|going|out|in progress|on it|waiting)\b|\bin progress\b|\bwaiting (?:on|for)\b|\b(?:will|i'?ll|we'?ll) (?:report|update|let you know|follow up|send)\b|\bonce (?:it|they|the \w+|both|all|each) (?:finish|finishes|report|reports|lands?|is done|are done|comes? back)\b|\bwhen (?:it|they|the \w+) (?:finish|finishes|report|reports)\b|\b\d+ of \d+\b|\bnot (?:yet|done)\b|\bremaining\b|\bstill (?:need|have|to)\b/;

/** Whether a reply says the job is finished (and doesn't say some of it still runs). */
export function claimsDone(text: string): boolean {
  const plain = text.replace(/[*_`#>~]/g, "").toLowerCase();
  return !STILL.test(plain) && DONE.some((pattern) => pattern.test(plain));
}

/** The Lead's last reply, when its last turn is over; undefined while it works or before it said anything. */
function lastReply(chat: Session): string | undefined {
  if (chat.busy || isPreparingHandoff(chat)) return undefined;
  for (let index = chat.blocks.length - 1; index >= 0; index--) {
    const block = chat.blocks[index];
    if (block.role === "user" && !block.draft) return undefined;
    if (block.role === "system" && block.notice === "still-running") return undefined;
    if (block.role === "assistant" && !block.tool && !block.internal && block.text.trim()) return block.text;
  }
  return undefined;
}

/**
 * The note a Lead's chat gets now, if any: its last turn is over and says the job is done, while tasks it delegated
 * (`rows`, any chat's: only this chat's own open ones count) are still out, or one it delegated did not finish (failed,
 * or said it cannot finish: workerStuck.ts `unfinishedWorker`). Once per task and once per `brief` (the leadership
 * brief it works on), so it never repeats and never holds the Lead.
 */
/**
 * r70: a note saved before r70 reads the new way too ("Still running: 2 (API, UI)" → "Still working on API, UI").
 */
export function stillRunningText(text: string): string {
  return text.replace(/^Still running: \d+ \(([^)]*)\)/, "Still working on $1");
}

/** r70 (Critiquito): the still-running note is a line in the body font, not grey monospace. */
export const STILL_RUNNING_CLASS = "min-w-0 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-content/85";

export function stillRunningNote(
  chat: Session,
  rows: readonly Delegation[],
  brief?: Pick<Delegation, "id" | "title">,
  now = Date.now(),
): Block | undefined {
  const own = rows.filter((row) => row.ownerSession === chat.id);
  // A declared block is not "still running": it said it cannot finish, so it reads under Not finished.
  const open = own
    .filter((row) => isOpenDelegation(row) && row.stallKind !== "blocked")
    .sort((a, b) => a.createdAt - b.createdAt);
  // D5: what a worker did is part of whether the job is done, so a done claim is checked against it.
  const unfinished = own
    .filter((row) => unfinishedWorker(row, now) !== undefined)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!open.length && !unfinished.length) return undefined;
  const reply = lastReply(chat);
  if (!reply || !claimsDone(reply)) return undefined;
  const noted = chat.blocks.flatMap((block) => (block.stillRunning ? [block.stillRunning] : []));
  if (brief && noted.some((note) => note.briefId === brief.id)) return undefined;
  const covered = new Set(noted.flatMap((note) => note.taskIds));
  if ([...open, ...unfinished].every((row) => covered.has(row.id))) return undefined;
  const taskIds = [...new Set([...open, ...unfinished].map((row) => row.id))];
  const title = brief?.title?.trim().split("\n")[0].slice(0, 80);
  const parts = [
    // r70 (Critiquito): "Still working on API, UI", not "Still running: 2 (API, UI)".
    ...(open.length ? [`Still working on ${names(open.map(taskName))}`] : []),
    ...(unfinished.length
      ? [
          `Not finished: ${unfinished.length} (${names(
            unfinished.map((row) => `${taskName(row)} — ${unfinishedWorker(row, now)}`),
          )})`,
        ]
      : []),
  ];
  const tail = unfinished.length
    ? brief
      ? `${title ? `"${title}"` : "The brief"} is not done.`
      : "The work is not done yet."
    : brief
      ? `${title ? `"${title}"` : "The brief"} stays open until they report back.`
      : "Their reports come back here when they finish.";
  return {
    id: `still-running-${taskIds.join("_")}`.slice(0, 200),
    role: "system",
    notice: "still-running",
    text: `${parts.join(". ")}. ${tail}`,
    stillRunning: { taskIds, ...(brief ? { briefId: brief.id } : {}) },
  };
}
