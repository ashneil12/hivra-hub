// This Mac's own chats as the other end of a move (WP-177). A desktop chat (a Session row) becomes the move's chat, and
// a moved copy becomes a Session row again. The port is the desktop chat store: get, put and remove a row. Nothing here
// writes the store itself, so the caller decides where the rows live.

import { hasPendingApproval, type Session } from "../../sessions/model/session";
import { buildDeterministicHandoff } from "../../sessions/model/handoff";
import type { MoveRefusal } from "./teleport";
import {
  sha256Hex,
  type CanResume,
  type ChatRecord,
  type ChatSnapshot,
  type MoveEndpoint,
  type MovePayload,
  type Provider,
  type ReceiveReply,
  type TransferChat,
} from "./teleport";

export interface LocalChatPort {
  get(id: string): Promise<Session | null>;
  put(session: Session): Promise<void>;
  remove(id: string): Promise<void>;
}

const RUNS_HERE: readonly string[] = ["claude", "codex"];

/** A desktop chat as a move's chat. The transcript is the chat's blocks as saved, not the provider's own file. */
export function sessionToChat(session: Session): ChatSnapshot {
  return {
    chatId: session.id,
    provider: session.harness as Provider,
    providerSessionId: session.providerSessionId ?? "",
    model: session.model,
    effort: session.modelSettings?.effort ?? "",
    title: session.title,
    transcript: JSON.stringify(session.blocks),
    queued: (session.queuedMessages ?? []).map((message) => message.text),
    turnRunning: session.busy === true,
    approvalPending: hasPendingApproval(session.blocks),
  };
}

/** A moved copy as a desktop chat. The project folder stays this Mac's, so the caller supplies it. */
export function chatToSession(chat: TransferChat, options: { cwd: string }): Session {
  return {
    id: chat.chatId,
    harness: chat.provider,
    model: chat.model,
    modelSettings: chat.effort ? { effort: chat.effort } : {},
    runtimeMode: "default",
    title: chat.title,
    cwd: options.cwd,
    blocks: JSON.parse(chat.transcript),
    providerSessionId: chat.providerSessionId,
    queuedMessages: chat.queued.map((text, index) => ({ id: `${chat.chatId}-queued-${index}`, text, attachments: [] })),
  } as unknown as Session;
}

/**
 * This Mac as a move endpoint. A chat is live here while its row exists. Freezing is held by this endpoint; the send
 * path that checks it is not wired yet (see the PR notes).
 */
export function localMoveEndpoint(options: { machineId: string; port: LocalChatPort; cwd: string }): MoveEndpoint {
  const { machineId, port, cwd } = options;
  const frozen = new Map<string, string>();
  const incoming = new Map<string, { moveId: string; payload: MovePayload }>();
  return {
    id: machineId,
    async read(chatId): Promise<ChatRecord | null> {
      const session = await port.get(chatId);
      return session ? { owner: machineId, live: sessionToChat(session) } : null;
    },
    async freeze(chatId, moveId) {
      if (frozen.has(chatId)) return false;
      frozen.set(chatId, moveId);
      return true;
    },
    async thaw(chatId, moveId) {
      if (frozen.get(chatId) === moveId) frozen.delete(chatId);
    },
    async canResume(provider, model, effort): Promise<CanResume> {
      if (!RUNS_HERE.includes(provider)) return { ok: false, reason: `this machine does not run ${provider}` };
      if (!model || !effort) return { ok: false, reason: "the chat has no model or effort to resume with" };
      return { ok: true };
    },
    async receive(chatId, moveId, payload): Promise<ReceiveReply> {
      if (incoming.has(chatId)) return { ok: false, reason: "held" };
      incoming.set(chatId, { moveId, payload });
      return { ok: true, transcriptSha256: await sha256Hex(payload.chat.transcript) };
    },
    async discard(chatId, moveId) {
      if (incoming.get(chatId)?.moveId === moveId) incoming.delete(chatId);
    },
    async activate(chatId, moveId) {
      const copy = incoming.get(chatId);
      if (!copy || copy.moveId !== moveId) return;
      await port.put(chatToSession(copy.payload.chat, { cwd }));
      incoming.delete(chatId);
    },
    async release(chatId, moveId) {
      if (frozen.get(chatId) !== moveId) throw new Error("This move did not freeze the chat");
      await port.remove(chatId);
      frozen.delete(chatId);
    },
  };
}

/**
 * The recap fallback (WP-121): when the other machine cannot resume the chat, the existing recap brief is built from
 * this chat's own record, for a new chat. Null for any refusal that is not a resume problem.
 */
export function recapForRefusal(session: Session, refusal: Pick<MoveRefusal, "reason" | "recapOffered">): string | null {
  if (refusal.reason !== "cannot-resume" || refusal.recapOffered !== true) return null;
  return buildDeterministicHandoff(session);
}
