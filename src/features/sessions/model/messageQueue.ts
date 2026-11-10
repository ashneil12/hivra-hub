import { parksForApproval } from "./approvalCarry";
import { isPreparingHandoff } from "./handoff";
import { resumeStopped, wasTurnInterrupted } from "./inFlight";
import type { Block, MessageQueueStatus, QueuedMessage, Session, TurnIntent } from "./session";
import { freeTextReply, type UserQuestionReply } from "./userQuestion";

export function queuedHead(session: Session): QueuedMessage | undefined {
  return session.queuedMessages?.[0];
}

/**
 * A brief another chat sent through the app that waits for this chat to be idle (sessions.send in queue mode, a brief
 * queued behind a Lead's work): it goes in as its own turn, under its request id.
 */
export function isWaitingBrief(message: QueuedMessage | undefined): boolean {
  return !!message?.waitForIdle && !!message.appRequestId && !message.monoSessionCompletion;
}

/**
 * Something the app queued for an idle chat, not Ash: a waiting brief, or a notification for a Mono (a worker's report,
 * a PR wake), which never steers its work either.
 */
export function isAppDelivery(message: QueuedMessage | undefined): boolean {
  return isWaitingBrief(message) || !!message?.monoSessionCompletion;
}

/** A message Ash typed himself: not an app delivery, a checker's note or a brief another chat sent through the app. */
export function isOwnMessage(message: QueuedMessage): boolean {
  return !message.appRequestId && !message.waitForIdle && !message.monoSessionCompletion;
}

/**
 * The queue with `message` added. Ash's own messages go first: ahead of everything the app queued (workers' reports,
 * question and PR wakes, briefs from other chats), in the order he sent them, so he is never stuck behind a report and
 * a Mono mid-turn can steer his message straight into its work (`canSteerQueuedHead` looks at the head only). Anything
 * else waits at the back.
 */
export function withQueued(queue: readonly QueuedMessage[], message: QueuedMessage): QueuedMessage[] {
  if (!isOwnMessage(message)) return [...queue, message];
  return [...queue.filter(isOwnMessage), message, ...queue.filter((entry) => !isOwnMessage(entry))];
}

/** The request id the delivery's user bubble carries once it went in (a report's is its receipt, its queue id). */
function deliveredAs(message: QueuedMessage): string | undefined {
  if (isWaitingBrief(message)) return message.appRequestId;
  return message.monoSessionCompletion ? message.id : undefined;
}

/**
 * The head is an app delivery behind a turn a restart cut: it waits for that turn's resume, and for Ash when the chat
 * stopped resuming itself (Needs you). The resume itself, and Ash's own message, go in ahead of it.
 */
export function waitsOnCutTurn(session: Session): boolean {
  return isAppDelivery(queuedHead(session)) && (wasTurnInterrupted(session) || resumeStopped(session));
}

/**
 * The queue a restart hands back. Ash's own queued messages wait for him, as they always have (the restart cut the turn
 * they were queued behind), and so does a queue he paused or stopped and any queue in an archived chat. A queue of
 * nothing but app deliveries (briefs other chats sent, a Mono's reports) keeps going: each goes in by itself, in order,
 * once its chat is idle again, after the cut turn's resume (`waitsOnCutTurn`). One the transcript shows already went in
 * is dropped, so none goes in twice.
 */
export function restoredQueue(
  queued: QueuedMessage[],
  blocks: readonly Block[],
  saved: { status?: MessageQueueStatus; archived?: boolean },
): Pick<Session, "queuedMessages" | "queueStatus"> {
  const sent = new Set(
    blocks.flatMap((block) => (block.role === "user" && !block.draft && block.appRequestId ? [block.appRequestId] : [])),
  );
  const left = queued.filter((message) => {
    const id = deliveredAs(message);
    return !(id && sent.has(id));
  });
  if (!left.length) return {};
  const keepsGoing = saved.status !== "paused" && !saved.archived && left.every(isAppDelivery);
  return { queuedMessages: left, queueStatus: keepsGoing ? "active" : "paused" };
}

/** Hold auto-dispatch only while the item about to send is being edited. */
export function isEditingQueuedHead(session: Session): boolean {
  const head = queuedHead(session);
  return Boolean(head && session.editingQueuedMessageId === head.id);
}

export function dequeueQueuedMessage(
  session: Session,
  messageId: string,
): Session {
  const queuedMessages = (session.queuedMessages ?? []).filter(
    (message) => message.id !== messageId,
  );
  return {
    ...session,
    queuedMessages: queuedMessages.length > 0 ? queuedMessages : undefined,
    queueStatus: queuedMessages.length > 0 ? session.queueStatus : undefined,
    editingQueuedMessageId:
      session.editingQueuedMessageId === messageId
        ? undefined
        : session.editingQueuedMessageId,
  };
}

/**
 * True when the idle session can send its queued head as a new turn.
 * Busy / paused / resuming / usage-limited / preparing-handoff /
 * editing-the-head all wait.
 */
export function canDispatchQueuedHead(session: Session): boolean {
  if (session.busy) return false;
  if (session.worktreePreparing || session.worktreeRemoved) return false;
  if (session.usageLimit) return false;
  if (session.queueStatus === "paused" || session.queueStatus === "resuming") {
    return false;
  }
  const head = queuedHead(session);
  if (!head) return false;
  if (isEditingQueuedHead(session)) return false;
  if (isPreparingHandoff(session)) return false;
  if (waitsOnCutTurn(session)) return false;
  return true;
}

/** Monos deliver one waiting follow-up at a time after the provider is ready. */
export function canSteerQueuedHead(session: Session): boolean {
  const head = queuedHead(session);
  return (
    !!head &&
    !head.monoSessionCompletion &&
    // A brief its sender queued behind the current work waits for an idle chat; Ash's answer to a held question doesn't.
    (!head.waitForIdle || !!head.steerWhenBusy) &&
    !!session.busy &&
    !!session.turnReady &&
    !session.worktreePreparing &&
    !session.worktreeRemoved &&
    !session.pendingSwitch &&
    !session.usageLimit &&
    !(
      session.pendingQuestion && session.pendingQuestion.autoResolveAt == null
    ) &&
    session.queueStatus !== "paused" &&
    session.queueStatus !== "resuming" &&
    !isEditingQueuedHead(session) &&
    !isPreparingHandoff(session) &&
    // WP-146: a queued follow-up does not enter a turn that is still waiting on approval, unless the agent
    // has yielded with only background work left (the send path hands it over then too).
    !parksForApproval(session) &&
    head.intent !== "plan" &&
    head.intent !== "orchestrate"
  );
}

/** Resolve a queued row for auto-dispatch (head, idle) or an explicit Steer. */
export function queuedMessageForSubmit(
  session: Session,
  messageId: string,
  mode: "dispatch" | "steer",
): QueuedMessage | undefined {
  const message = session.queuedMessages?.find(
    (entry) => entry.id === messageId,
  );
  if (!message) return undefined;
  if (mode === "steer") return message.monoSessionCompletion ? undefined : message;
  if (queuedHead(session)?.id !== messageId) return undefined;
  if (!canDispatchQueuedHead(session)) return undefined;
  return message;
}

/** What a submitted message says about who sent it (the composer's options, as App.tsx's submit takes them). */
export type SubmittedBy = {
  appRequestId?: string;
  waitForIdle?: boolean;
  monoSessionCompletion?: unknown;
  monoCheck?: unknown;
  monoNote?: unknown;
  managed?: boolean;
  autoResume?: number;
  ciRepair?: unknown;
  resendEdited?: boolean;
  queuedMessageId?: string;
  draftBlockId?: string;
  intent?: TurnIntent;
  /** Today's or a Page's words for the chat: Ash's own. */
  followsUp?: boolean;
};

/** Ash typed it himself (the composer, Today's or a Page's reply): not an app delivery, a resume or a resend. */
export function isAshTyped(by: SubmittedBy): boolean {
  return (
    !by.appRequestId &&
    !by.waitForIdle &&
    !by.monoSessionCompletion &&
    !by.monoCheck &&
    !by.monoNote &&
    !by.managed &&
    !by.autoResume &&
    !by.ciRepair &&
    !by.resendEdited &&
    !by.queuedMessageId &&
    !by.draftBlockId &&
    (by.intent ?? "default") === "default"
  );
}

export type TypedQuestionAnswer =
  | { kind: "answer"; requestId: number; reply: UserQuestionReply }
  /** No question takes words: set it aside (Escape in Claude Code), and his message goes in next. */
  | { kind: "dismiss"; requestId: number };

/**
 * Ash typed in a chat whose agent is waiting on its own question (AskUserQuestion): his words are the answer, the way
 * Claude Code's own picker takes a typed answer. Never a message queued behind the question it waits on, which no
 * queue rule may steer past (`canSteerQueuedHead`) and so would never arrive. A question with no free-text answer is
 * set aside instead, so his message goes in right after.
 */
export function typedQuestionAnswer(
  session: Pick<Session, "pendingQuestion" | "worktreeRemoved">,
  text: string,
  by: SubmittedBy,
): TypedQuestionAnswer | undefined {
  const prompt = session.pendingQuestion;
  // An optional question with its own deadline doesn't block the chat: his message steers in as usual.
  if (!prompt || prompt.autoResolveAt != null || session.worktreeRemoved || !text.trim() || !isAshTyped(by)) return undefined;
  const reply = freeTextReply(prompt.questions, text);
  return reply
    ? { kind: "answer", requestId: prompt.requestId, reply }
    : { kind: "dismiss", requestId: prompt.requestId };
}
