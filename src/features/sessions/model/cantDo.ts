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

/** What the app does with a message sent while the chat is busy. */
export type BusyFollowUp =
  /** Add it to the queue; it goes out when the chat is idle. */
  | "queue"
  /** Write it into the running turn now. */
  | "steer"
  /** It is already in the queue and cannot go in yet: leave it where it is. */
  | "stay";

export type BusyFollowUpInput = {
  /** The person's Settings choice, or the one the caller passed. */
  setting: "queue" | "steer";
  /**
   * The message has to wait for an idle chat: a preparing worktree, a plan or
   * orchestrate request, /operator, waitForIdle. Add the other reasons here.
   */
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
  /** The message is already in the queue (its own Steer button, or the queue handing over its head). */
  alreadyQueued: boolean;
};

/**
 * What a message sent while the chat is busy does.
 *
 * A CLI that cannot redirect cannot take a steer, and neither can a chat the
 * app is compacting (the message would land inside the compact). Either way a
 * new message waits in the queue and Send stays Send. Stop is the empty box.
 *
 * A message that is already in the queue is never added to it a second time.
 * When it is to be steered the caller steers it, or refuses when this agent
 * cannot take one (it stays queued). When it has to wait for an idle chat it
 * is told to "stay".
 */
export function followUpWhenBusy(input: BusyFollowUpInput): BusyFollowUp {
  const asked: "queue" | "steer" = input.mustWait
    ? "queue"
    : input.onlyBackgroundWork
      ? "steer"
      : input.mono
        ? input.steerable
          ? "steer"
          : "queue"
        : input.setting;
  if (input.alreadyQueued) return asked === "steer" ? "steer" : "stay";
  return input.cannotRedirect || input.compacting ? "queue" : asked;
}

/** Said when a queued message is told to wait: its Steer button was pressed, or the queue offered it. */
export const QUEUED_MESSAGE_WAITS = "That message sends when the current turn finishes.";

/** Shown while the app compacts this chat in the background. One plain sentence per fact. */
export const COMPACTING_NOTE =
  "Compacting this chat while it's idle. A message you send now waits until that finishes.";

export type RedirectNotePlace = "queue" | "composer" | "none";

/**
 * One sentence. On the queue when a message is waiting there (Steer is the
 * lie). Beside the box only when it has to be seen with nothing queued: the
 * app is compacting the chat. Otherwise hidden.
 */
export function redirectNotePlace(
  note: string | undefined,
  queueVisible: boolean,
  besideBox: boolean,
): RedirectNotePlace {
  if (!note?.trim()) return "none";
  if (queueVisible) return "queue";
  return besideBox ? "composer" : "none";
}
