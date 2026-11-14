// r101 (5, B5 571a: the Lead said nothing from +360s to +2050s while its worker ran): a Lead with work out for about
// five minutes gets a factual app update, including when no new report arrived. It carries no Needs you or badge.
import { isBackgroundMessage } from "../../sessions/model/backgroundMessage";
import { isStatusQuestion } from "./statusReply";
import type { Block, Session } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation } from "./delegations";

export const PROGRESS_PREFIX = "progress-";
export const PROGRESS_QUIET_MS = 5 * 60_000;

const said = (block: Block) =>
  (block.role === "assistant" && !block.tool && !block.internal && !!block.text.trim()) || block.id.startsWith(PROGRESS_PREFIX);

/** "2 of 5" from an earlier note's id (progress-<done>-<total>-<at>[-w<worker line's key>]). */
function lastNote(chat: Session): { done: number; total: number; at: number; worker?: string } | undefined {
  for (let i = chat.blocks.length - 1; i >= 0; i--) {
    const m = /^progress-(\d+)-(\d+)-(\d+)(?:-w(\w+))?$/.exec(chat.blocks[i]!.id);
    if (m) return { done: Number(m[1]), total: Number(m[2]), at: Number(m[3]), ...(m[4] ? { worker: m[4] } : {}) };
  }
  return undefined;
}

/** A worker chat's newest line of its own words, and when it said it. */
export type WorkerLine = { text: string; at: number };

/** The worker's newest words, from its chat's blocks. */
export function workerLineOf(chat: Pick<Session, "blocks"> | undefined): WorkerLine | undefined {
  const block = [...(chat?.blocks ?? [])].reverse().find((b) => b.role === "assistant" && !b.tool && !b.internal && !b.streaming && !!b.text.trim());
  return block ? { text: block.text, at: block.startedAt ?? block.sentAt ?? 0 } : undefined;
}

const keyOf = (text: string) => {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
};

/** "Independent screen fixes are in. I'll commit…" -> its first sentence, short. */
function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]+$/, "");
  return one.length > 90 ? `${one.slice(0, 87).replace(/\s+\S*$/, "")}…` : one;
}

export function progressNote(
  chat: Session,
  rows: readonly Delegation[],
  now = Date.now(),
  workerLine: (childSession: string) => WorkerLine | undefined = () => undefined,
): Block | undefined {
  // Its jobs since Ash's last message: the work in hand.
  const requests = chat.blocks.filter((b) => b.role === "user" && !b.draft && !b.monoNote && !/^\s*\[MonoCode /.test(b.text) && !isBackgroundMessage(b.text) && !isStatusQuestion(b.text));
  const ask = requests[requests.length - 1];
  const since = ask?.startedAt ?? ask?.sentAt ?? 0;
  const owners = rows.filter((row) => row.ownerSession === chat.id && row.state !== "cancelled");
  const active = owners.filter(isOpenDelegation);
  if (!active.length) return undefined;
  // A later "how is it going?" does not detach work already running from its owner.
  const earliest = Math.min(...active.map((row) => row.createdAt));
  const anchor = [...requests].reverse().find((block) => (block.startedAt ?? block.sentAt ?? 0) <= earliest);
  const from = Math.min(since, anchor?.startedAt ?? anchor?.sentAt ?? earliest);
  const batches = new Set(active.map((row) => row.batchId).filter(Boolean));
  const roots = new Set(active.map((row) => row.rootId).filter(Boolean));
  const own = owners.filter((row) => row.createdAt >= from || (!!row.batchId && batches.has(row.batchId)) || (!!row.rootId && roots.has(row.rootId)));
  const total = own.length;
  const done = own.filter((row) => row.state === "completed").length;
  const prev = lastNote(chat);
  // r102 (5, 05bc/d241: 14 to 18 quiet minutes on one long job, still 0 of 1): with one job out and none back, the note
  // quotes new worker words when available, otherwise reports that no new report arrived.
  const single = total === 1 && done === 0 ? own[0]! : undefined;
  const line = single ? workerLine(single.childSession) : undefined;
  const moved = !!line && keyOf(line.text) !== prev?.worker && line.at > (prev?.at ?? 0);
  const unchanged = !moved && (prev ? prev.done === done && prev.total === total : done === 0);
  // Quiet for the reporting interval: no word from the Lead and no note since.
  const lastSaid = Math.max(
    prev?.at ?? 0,
    ...own.map((row) => row.createdAt),
    ...chat.blocks.filter(said).map((b) => b.startedAt ?? b.sentAt ?? 0),
  );
  if (now - lastSaid < PROGRESS_QUIET_MS) return undefined;
  if (unchanged) {
    const waiting = active.filter((row) => row.state === "question").length;
    const running = active.length - waiting;
    return {
      id: `${PROGRESS_PREFIX}${done}-${total}-${now}${prev?.worker ? `-w${prev.worker}` : ""}`,
      role: "system",
      notice: "still-running",
      text: `No new worker report yet: ${done} of ${total} jobs finished; ${running} running${waiting ? `, ${waiting} waiting for an answer` : ""}.`,
      startedAt: now,
    };
  }
  if (moved && single && line) {
    const what = single.title?.trim();
    return {
      id: `${PROGRESS_PREFIX}${done}-${total}-${now}-w${keyOf(line.text)}`,
      role: "system",
      notice: "still-running",
      text: `Still working${what ? ` on ${what}` : ""}: ${firstSentence(line.text)}.`,
    };
  }
  return { id: `${PROGRESS_PREFIX}${done}-${total}-${now}`, role: "system", notice: "still-running", startedAt: now, text: `Still working: ${done} of ${total} jobs done.` };
}
