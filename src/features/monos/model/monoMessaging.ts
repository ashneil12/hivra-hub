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
 * A room (group chat) turn runs managed: its reply settles the room's wait. A message that waits in the outbox loses
 * that (`enqueueMonoMessage` keeps only what Ash would see), so the hidden room prompt would land in the Mono's chat as
 * a visible message and the room would wait out its timer. A Mono that is working, or has messages waiting (a queue Stop
 * paused included: the submit path queues behind them), refuses the room turn instead.
 */
export function monoRefusesRoomTurn(session: Session): boolean {
  return !!session.busy || !!session.queuedMessages?.length;
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
  return new Map(
    (session.queuedMessages ?? [])
      .filter((message) => !message.monoSessionCompletion)
      .map((message) => [
        message.blockId ?? message.id,
        {
          status: message.error
            ? "failed"
            : session.queueStatus === "paused"
              ? "paused"
              : "pending",
          ...(message.error ? { error: message.error } : {}),
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
    (message) => !message.monoSessionCompletion,
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
