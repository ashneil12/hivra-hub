// r84 (s14 r83): Ash answered a worker's question in its own chat. The Lead never heard it (no save, no word from it), the
// job already read "completed" with the stop text, and the worker following him over the Lead's pick rested on its
// prompt. Now: a worker that stops on Ash's choice keeps its job open (App.tsx turnEnded); his message in its chat
// re-attaches the job (delegations.ts resumeMonitor), so its next report goes to the Lead; the Lead gets an app message
// at once to save his call and say what happens next; and the worker's turn carries a note that his words decide.
import { forUser } from "../../hub/model/userName";
import type { QueuedMessage } from "../../sessions/model/session";
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
    text: forUser`${ASH_ANSWERED_PREFIX} From the app: Ash answered your worker on "${short(row.title || "its job", 80)}" in its chat: "${short(words, 400)}". The worker carries on from his words, not from any pick of yours. Save his call now with ash_remember, in his words, then tell him in one line what happens next (if you asked him this too, that line says it is answered; don't ask it again). Its report comes to you when it is done. This is an app notification, not a new message from Ash.`,
  };
}

/** What the worker's turn on Ash's own message carries. */
export function ashWordsNote(): string {
  return forUser`<monocode_app>\nThis message is Ash's own, typed in your chat. His words decide: they outrank your brief and any pick from your Lead. Build what he asked, run the checks, and report in a few lines (each check as one line, no pasted output).\n</monocode_app>`;
}
