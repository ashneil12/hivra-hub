import {
  appendSteerUser,
  appendUser,
} from "../../../integrations/harness/core/apply";
import { displayAttachments } from "../../sessions/model/attachments";
import {
  canDispatchQueuedHead,
  dequeueQueuedMessage,
  withQueued,
} from "../../sessions/model/messageQueue";
import { queueWaitReasons } from "../../sessions/model/queueWaitReason";
import type {
  Attachment,
  Block,
  QueuedMessage,
  Session,
} from "../../sessions/model/session";

type UserCards = Parameters<typeof appendUser>[3];
export type MessageDelivery = {
  status: "pending" | "paused" | "failed";
  error?: string;
  /** WP-245: why it hasn't gone in yet, in a few words ("Behind 2 messages", "Waiting for your approval"). */
  waitReason?: string;
};

/** Show the message now; the outbox only controls its delivery (Ash's own ahead of the app's, `withQueued`). */
export function enqueueMonoMessage(
  session: Session,
  message: QueuedMessage,
  cards?: UserCards,
): Session {
  const appended = appendSteerUser(
    session,
    message.text,
    displayAttachments(message.attachments),
    cards,
  );
  const bubble = {
    ...appended.blocks[appended.blocks.length - 1],
    id: message.id,
  };
  return {
    ...session,
    blocks: [...session.blocks, bubble],
    queuedMessages: withQueued(session.queuedMessages ?? [], {
      ...message,
      blockId: bubble.id,
    }),
    queueStatus: session.queueStatus === "paused" ? "paused" : "active",
  };
}

/**
 * A room (group chat) turn runs managed when the Mono is free: its reply is the room post. A Mono that is working, or
 * has messages waiting (a queue Stop paused included), takes the room's turn as a wake in its queue instead
 * (`queueRoomWake`): steered into its work, or sent behind it, and answered with room_post. Never refused.
 */
export function monoTakesRoomTurnNow(session: Session): boolean {
  return !session.busy && !session.queuedMessages?.length && !session.pendingSwitch && !session.usageLimit;
}

/**
 * A room's wake or another Mono's private message in a Mono's queue: hidden (no pending bubble), shown once it goes in
 * as one quiet line. A wake may steer into the running work; a private message waits for an idle chat.
 */
export function queueMonoNote(
  session: Session,
  message: { id: string; text: string; note: NonNullable<QueuedMessage["monoNote"]>; waitForIdle?: boolean; attachments?: Attachment[] },
): Session {
  if (session.queuedMessages?.some((m) => m.id === message.id) || session.blocks.some((b) => b.appRequestId === message.id)) return session;
  return {
    ...session,
    queuedMessages: [
      ...(session.queuedMessages ?? []),
      {
        id: message.id,
        text: message.text,
        attachments: message.attachments ?? [],
        appRequestId: message.id,
        monoNote: message.note,
        ...(message.waitForIdle ? { waitForIdle: true } : {}),
      },
    ],
    queueStatus: session.queueStatus === "paused" ? "paused" : "active",
  };
}

/** Acknowledgement updates the existing bubble instead of appending it again. */
export function acknowledgeMonoMessage(
  session: Session,
  message: QueuedMessage,
  options: {
    mode: "follow-up" | "new-turn";
    text?: string;
    attachments?: Attachment[];
    cards?: UserCards;
  },
): Session {
  const remaining = dequeueQueuedMessage(session, message.id);
  const append = options.mode === "new-turn" ? appendUser : appendSteerUser;
  const appended = append(
    remaining,
    options.text ?? message.text,
    options.attachments ?? displayAttachments(message.attachments),
    options.cards,
  );
  const accepted = appended.blocks[appended.blocks.length - 1];
  const blocks = message.blockId
    ? remaining.blocks.map((block) =>
        block.id === message.blockId
          ? {
              ...block,
              ...accepted,
              id: block.id,
              sentAt: block.sentAt ?? accepted.sentAt,
            }
          : block,
      )
    : [...remaining.blocks, { ...accepted, id: message.id }];
  return options.mode === "new-turn"
    ? { ...appended, blocks }
    : { ...remaining, blocks };
}

export function monoMessageDeliveries(
  session: Session,
): ReadonlyMap<string, MessageDelivery> {
  const reasons = queueWaitReasons(session);
  return new Map(
    (session.queuedMessages ?? [])
      .filter((message) => !message.monoSessionCompletion && !message.monoNote)
      .map((message) => [
        message.blockId ?? message.id,
        {
          status: message.error
            ? "failed"
            : session.queueStatus === "paused"
              ? "paused"
              : "pending",
          ...(message.error ? { error: message.error } : {}),
          // A paused or failed bubble already says so with its own control; only a pending one needs the reason.
          ...(!message.error && session.queueStatus !== "paused" && reasons.get(message.id)
            ? { waitReason: reasons.get(message.id) }
            : {}),
        },
      ]),
  );
}

/** Ready reports deliver in the background; only waiting or failed ones need a queue row. */
export function visibleMonoCompletionMessages(
  session: Session,
): QueuedMessage[] {
  const ready = canDispatchQueuedHead(session);
  return (session.queuedMessages ?? []).filter(
    (message) => !!message.monoSessionCompletion && (!ready || !!message.error),
  );
}

const legacyBubbles = new WeakMap<QueuedMessage, Block>();
/** Older queues had no bubble; pending pasted images also need their saved bytes. */
export function monoPendingTranscriptBlocks(
  session: Session,
  blocks: Block[],
): Block[] {
  const messages = session.queuedMessages?.filter(
    (message) => !message.monoSessionCompletion && !message.monoNote,
  );
  if (!messages?.length) return blocks;
  const byBlock = new Map(
    messages.map((message) => [message.blockId ?? message.id, message]),
  );
  let changed = false;
  const visible = blocks.map((block) => {
    const message = byBlock.get(block.id);
    if (
      !message ||
      !message.attachments.some(
        (file) =>
          file.data &&
          !block.attachments?.some(
            (saved) => saved.id === file.id && saved.data === file.data,
          ),
      )
    )
      return block;
    changed = true;
    return { ...block, attachments: displayAttachments(message.attachments) };
  });
  for (const message of messages) {
    if (message.blockId || blocks.some((block) => block.id === message.id))
      continue;
    let bubble = legacyBubbles.get(message);
    if (!bubble) {
      const preview = enqueueMonoMessage(
        { ...session, blocks: [], queuedMessages: undefined },
        message,
      );
      bubble = preview.blocks[0];
      legacyBubbles.set(message, bubble);
    }
    visible.push(bubble);
    changed = true;
  }
  return changed ? visible : blocks;
}
