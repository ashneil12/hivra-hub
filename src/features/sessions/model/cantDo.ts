import { HARNESS_TITLE, type HarnessId } from "./session";

/** What to do instead, when this agent cannot redirect a running turn. */
export function cantRedirectTurn(harness: HarnessId): string {
  return `${HARNESS_TITLE[harness]} can't redirect a running turn. Stop it, then send.`;
}

/**
 * A harness that is not live cannot take the follow-up either, but that is
 * not the same as a known refusal to redirect.
 */
export function cantTakeFollowUp(harness: HarnessId): string {
  return `${HARNESS_TITLE[harness]} can't take a follow-up mid-turn. Wait for this turn to finish, or stop it first.`;
}

/**
 * What a typed message does while a turn runs. A CLI that cannot redirect
 * cannot steer, so the message waits in the queue and Send stays Send.
 */
export function followUpWhenBusy(
  cannotRedirect: boolean,
  followUp: string,
): "queue" | "steer" {
  if (cannotRedirect || followUp === "queue") return "queue";
  return "steer";
}

/**
 * Send stays Send while the box has text. Stop is the empty box, not a
 * stand-in for a redirect this agent cannot do.
 */
export function blocksBusySend(cannotRedirect: boolean, followUp: string): boolean {
  return followUpWhenBusy(cannotRedirect, followUp) === "steer" && cannotRedirect;
}

export type RedirectNotePlace = "queue" | "composer" | "none";

/**
 * One sentence. On the queue when a message is waiting there (Steer is the
 * lie). Beside the box only when Send itself would try to redirect. Hidden
 * when follow-ups already wait in the queue and nothing is queued.
 */
export function redirectNotePlace(
  note: string | undefined,
  queueVisible: boolean,
  blocksSend: boolean,
): RedirectNotePlace {
  if (!note?.trim()) return "none";
  if (queueVisible) return "queue";
  return blocksSend ? "composer" : "none";
}
