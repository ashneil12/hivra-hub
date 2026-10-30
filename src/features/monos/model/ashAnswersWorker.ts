// r84 (s14 r83): Ash answered a worker's question in its own chat. The Lead never heard it (no save, no word from it), the
// job already read "completed" with the stop text, and the worker following him over the Lead's pick rested on its
// prompt. Now: a worker that stops on Ash's choice keeps its job open (App.tsx turnEnded); his message in its chat
// re-attaches the job (delegations.ts resumeMonitor), so its next report goes to the Lead; the Lead gets an app message
// at once to save his call and say what happens next; and the worker's turn carries a note that his words decide.
import { forUser } from "../../hub/model/userName";
import type { QueuedMessage } from "../../sessions/model/session";
import { isQuestionWakeFor } from "./delegationQuestions";
import { isOpenDelegation, type Delegation } from "./delegations";

export const ASH_ANSWERED_PREFIX = "[MonoCode Ash answered]";

/** The open job of a worker chat, if it has one: the newest row for it as child that is still running or asking. */
export function openJobOf(rows: readonly Delegation[], workerChat: string): Delegation | undefined {
  let found: Delegation | undefined;
  for (const row of rows) if (row.childSession === workerChat && !row.follow && (!found || row.createdAt > found.createdAt)) found = row;
  return found && isOpenDelegation(found) ? found : undefined;
}

const short = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The Lead's app message: Ash's own words, and what to do with them now. Once per Ash message (`answerId`). */
export function ashAnsweredLeadNote(row: Pick<Delegation, "id" | "title">, words: string, answerId: string): QueuedMessage {
  return {
    id: `ash-answered-${row.id}-${answerId}`.slice(0, 200),
    attachments: [],
    waitForIdle: true,
    // r86: it cuts into a busy Lead's turn, so the Lead never decides his call without him.
    steerWhenBusy: true,
    text: forUser`${ASH_ANSWERED_PREFIX} From the app: Ash answered your worker on "${short(row.title || "its job", 80)}" in its chat: "${short(words, 400)}". The worker carries on from his words, not from any pick of yours. Save his call now with ash_remember, in his words, then tell him in one line what happens next, as work still to come ("the worker will…"; nothing is in until its report lands; if you asked him this too, that line says it is answered; don't ask it again). Its report comes to you when it is done. This is an app notification, not a new message from Ash.`,
  };
}

/**
 * r89 (Ash): once he has answered in the worker's chat, the Lead's queued wake carrying that worker's question is
 * dropped, so the Lead never puts the answered question to him. The ids to take out of the Lead's queue.
 */
export function answeredQuestionWakes(lead: { queuedMessages?: readonly Pick<QueuedMessage, "id">[] } | undefined, workerChat: string): string[] {
  return (lead?.queuedMessages ?? []).filter((message) => isQuestionWakeFor(message, workerChat)).map((message) => message.id);
}

/**
 * r86 (s14 r85 run 1, +285s: the Lead, not yet told, started a second worker on "gone for good" after Ash had said "keep
 * them 30 days"): the jobs Ash answered in their worker's chat, with his words, for this window. A redo of such a job, or
 * a new one like it while it is still open, is turned back once with his words (agentAppTasks.ts delegate).
 */
const answered = new Map<string, { words: string; refused: Set<string>; at: number }>();
export function noteAshAnswer(rowId: string, words: string, at = Date.now()): void {
  answered.set(rowId, { words: short(words, 400), refused: new Set(), at });
}

/**
 * r88 (Ash): his words typed straight into a worker's chat sign the routes check off like a card answer does. True when
 * he answered one of these jobs in its worker's chat at or after `since`.
 */
export function ashAnsweredWorkerSince(rowIds: Iterable<string>, since: number): boolean {
  for (const id of rowIds) {
    const record = answered.get(id);
    if (record && record.at >= since) return true;
  }
  return false;
}
export function forgetAshAnswers(): void {
  answered.clear();
}

const significant = (title: string) =>
  new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
/** Two job titles name the same work: half or more of the shorter one's words are in the other. */
export function sameJob(a: string, b: string): boolean {
  const [x, y] = [significant(a), significant(b)];
  const small = x.size <= y.size ? x : y;
  const big = small === x ? y : x;
  if (!small.size) return false;
  let shared = 0;
  for (const word of small) if (big.has(word)) shared++;
  return shared * 2 >= small.size;
}

/**
 * Why a delegate_task call is turned back, if it is: it redoes a job Ash answered that is still open, or starts one like
 * it. Once per job and caller's request, so a second call that really is other work still starts.
 */
export function answeredJobRefusal(
  open: readonly Pick<Delegation, "id" | "title" | "state">[],
  call: { requestId: string; title: string; redoes?: Pick<Delegation, "id"> },
): string | undefined {
  for (const row of open) {
    const record = answered.get(row.id);
    if (!record || !isOpenDelegation(row) || record.refused.has(call.requestId)) continue;
    if (call.redoes?.id !== row.id && !sameJob(row.title ?? "", call.title)) continue;
    record.refused.add(call.requestId);
    return forUser`Not started: Ash already answered "${short(row.title || "that job", 80)}" in its worker's chat: "${record.words}". That worker is carrying on from his words, and its report comes to you. Don't start another or redo it; tell him in one line what happens next. If this really is other work, call delegate_task again and it starts.`;
  }
  return undefined;
}

/** What the worker's turn on Ash's own message carries. */
export function ashWordsNote(): string {
  return forUser`<monocode_app>\nThis message is Ash's own, typed in your chat. His words decide: they outrank your brief and any pick from your Lead. Build what he asked, run the checks, and report in a few lines (each check as one line, no pasted output).\n</monocode_app>`;
}
