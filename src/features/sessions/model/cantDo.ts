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

export type BusyFollowUp = "queue" | "steer";

export type BusyFollowUpInput = {
  /** The person's Settings choice, or the one the caller passed. */
  setting: BusyFollowUp;
  /** The message has to wait for an idle chat: a preparing worktree, a plan or orchestrate request, /operator, waitForIdle. */
  mustWait: boolean;
  /** The agent has yielded and only background work is left, which may never end (a dev server). */
  onlyBackgroundWork: boolean;
  /** A Mono: it reads the message now, or right after when it cannot take a steer. */
  mono: boolean;
  /** The agent is live and takes a steer, and the app is not compacting this chat. */
  steerable: boolean;
  /** A live agent that says it cannot redirect a running turn. */
  cannotRedirect: boolean;
  /** The app is compacting this idle chat in the background; its busy flag is the app's own. */
  compacting: boolean;
  /** The message is already in the queue (its own Steer button). */
  alreadyQueued: boolean;
};

/**
 * What a message sent while the chat is busy does.
 *
 * A CLI that cannot redirect cannot take a steer, and neither can a chat the
 * app is compacting (the message would land inside the compact). Either way
 * the message waits in the queue and Send stays Send. Stop is the empty box.
 *
 * A message that is already in the queue is never queued a second time. It
 * keeps what was asked, and the caller refuses a steer that cannot happen,
 * leaving the message where it is.
 */
export function followUpWhenBusy(input: BusyFollowUpInput): BusyFollowUp {
  const asked: BusyFollowUp = input.mustWait
    ? "queue"
    : input.onlyBackgroundWork
      ? "steer"
      : input.mono
        ? input.steerable
          ? "steer"
          : "queue"
        : input.setting;
  if (input.alreadyQueued) return asked;
  return input.cannotRedirect || input.compacting ? "queue" : asked;
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
