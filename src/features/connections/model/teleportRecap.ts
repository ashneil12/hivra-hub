// The recap fallback as a new chat (WP-177, WP-121): when the other machine cannot resume a chat, the new chat's first
// message is the existing deterministic handoff brief of the old one. The new chat keeps the folder, harness and model.

import { buildDeterministicHandoff } from "../../sessions/model/handoff";
import type { Block, Session } from "../../sessions/model/session";

export function recapChatFrom(session: Session): Session {
  const brief = buildDeterministicHandoff(session);
  const block: Block = { id: `recap-${crypto.randomUUID()}`, role: "user", text: brief };
  // A new chat, not a copy of the old one's Lead, crew or automation fields. The brief is queued so the next idle
  // turn sends it to the model; a block alone would only sit in the transcript.
  return {
    id: `chat-${crypto.randomUUID()}`,
    harness: session.harness,
    model: session.model,
    modelSettings: { ...(session.modelSettings ?? {}) },
    runtimeMode: session.runtimeMode,
    title: `Recap of ${session.title}`,
    cwd: session.cwd,
    blocks: [block],
    providerSessionId: undefined,
    queuedMessages: [{ id: `recap-send-${crypto.randomUUID()}`, text: brief, attachments: [] }],
    queueStatus: "active",
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

/**
 * The recap fallback (WP-121): when the other machine cannot resume the chat, the existing recap brief is built from this
 * chat's own record, for a new chat. Null for any refusal that is not a resume problem.
 */
export function recapForRefusal(session: Session, refusal: { reason: string; recapOffered?: boolean }): string | null {
  if (refusal.reason !== "cannot-resume" || refusal.recapOffered !== true) return null;
  return buildDeterministicHandoff(session);
}
