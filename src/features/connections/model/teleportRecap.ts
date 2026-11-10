// The recap fallback as a new chat (WP-177, WP-121): when the other machine cannot resume a chat, the new chat's first
// message is the existing deterministic handoff brief of the old one. The new chat keeps the folder, harness and model.

import { buildDeterministicHandoff } from "../../sessions/model/handoff";
import type { Block, Session } from "../../sessions/model/session";

export function recapChatFrom(session: Session): Session {
  const brief = buildDeterministicHandoff(session);
  const block: Block = { id: `recap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role: "user", text: brief };
  return {
    ...session,
    id: `chat-${crypto.randomUUID()}`,
    title: `Recap of ${session.title}`,
    providerSessionId: undefined,
    blocks: [block],
    queuedMessages: [],
    busy: false,
  } as unknown as Session;
}

/** The recap button: build the new chat, save it, and open it. The old chat is not changed. */
export async function startRecapChat(
  session: Session,
  deps: { save: (next: Session) => Promise<unknown>; open: (chatId: string) => void },
): Promise<Session> {
  const next = recapChatFrom(session);
  await deps.save(next);
  deps.open(next.id);
  return next;
}
