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
 * Typed text while a turn runs. Queue still sends (it waits). Steer does not,
 * when this agent cannot redirect.
 */
export function blocksBusySend(cannotRedirect: boolean, followUp: string): boolean {
  return cannotRedirect && followUp !== "queue";
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
