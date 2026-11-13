// SC-3b: runs the hold on a first mate's "ready to ship" (model/doneHold.ts) at the end of every first-mate turn. A turn
// ends when the chat goes idle, the same edge useFirstMateCheckoutGuard.ts watches, so this is a sibling of that hook:
// it reads the finished turn once and never polls. The app message and the grey note go out through the callbacks App.tsx
// gives it (the same ones the followed-briefs sweep uses), so a hold reaches the chat exactly as the other app notes do.
import { useEffect, useRef } from "react";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import { doneHold, holdDeps, type HoldDeps, type HoldRule } from "../model/doneHold";
import { isFirstMate } from "../model/checkoutGuard";
import { turnEdges } from "./useFirstMateCheckoutGuard";

export type DoneHoldSend = {
  /** Queue the app message in the chat; it waits for an idle chat and is never a steer. */
  ask(chatId: string, message: QueuedMessage): Promise<unknown> | void;
  /** Add the grey note to the chat (once per block id). */
  note(chatId: string, block: Block): void;
};

/**
 * A first-mate turn ended in `chatId`: hold its ready-to-ship claim if the rules say so. Never throws. The message goes
 * first and the note after it, so the chat never says "Held" for a message that was not queued; a send that fails gives
 * its memo back, so the next turn that ends tries again. Resolves true when a hold went out.
 */
export async function holdOnTurnEnd(
  chatId: string,
  sessions: () => readonly Session[],
  send: DoneHoldSend,
  deps: HoldDeps,
  memo: Set<string>,
  rules?: readonly HoldRule[],
): Promise<boolean> {
  const chat = sessions().find((session) => session.id === chatId);
  if (!chat) return false;
  const held = await doneHold(
    chat,
    { ...deps, fresh: deps.fresh ?? ((id) => sessions().find((session) => session.id === id)) },
    memo,
    rules,
  ).catch(() => undefined);
  if (!held) return false;
  try {
    await send.ask(chatId, held.message);
  } catch {
    memo.delete(held.key);
    return false;
  }
  send.note(chatId, held.note);
  return true;
}

export function useFirstMateDoneHold(options: {
  sessions: readonly Session[];
  ask: DoneHoldSend["ask"];
  note: DoneHoldSend["note"];
  deps?: HoldDeps;
  rules?: readonly HoldRule[];
}): void {
  const latest = useRef(options);
  latest.current = options;
  const busy = useRef<Set<string>>(new Set());
  // What was held, per chat and reason: the window's own memory, so a hold goes once per version per chat.
  const memo = useRef<Set<string>>(new Set());
  const key = options.sessions
    .filter(isFirstMate)
    .map((session) => `${session.id}:${session.busy ? 1 : 0}`)
    .join("\n");
  useEffect(() => {
    const now = latest.current;
    const edges = turnEdges(busy.current, now.sessions);
    busy.current = edges.busy;
    for (const id of edges.ended) {
      void holdOnTurnEnd(
        id,
        () => latest.current.sessions,
        { ask: (chatId, message) => latest.current.ask(chatId, message), note: (chatId, block) => latest.current.note(chatId, block) },
        now.deps ?? holdDeps(),
        memo.current,
        now.rules,
      );
    }
  }, [key]);
}
