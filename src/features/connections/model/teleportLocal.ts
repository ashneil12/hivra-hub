// This Mac's own chats as the other end of a move (WP-177). A desktop chat (a Session row) becomes the move's chat, and a
// moved copy becomes a Session row again. Every step a move takes here is saved in the chat row as a notice (the freeze,
// an incoming copy, the marker), so a restart or a crash still knows where the chat is. The port is the desktop chat
// store: get and put a row. Nothing here writes anything else.

import { hasPendingApproval, type Block, type Session } from "../../sessions/model/session";
import {
  sha256Hex,
  type CanResume,
  type ChatRecord,
  type ChatSnapshot,
  type Holds,
  type MoveEndpoint,
  type Provider,
  type ReceiveReply,
  type TransferChat,
} from "./teleport";
import { chatLockedFromBlocks, frozenBlock, frozenMoves, hasBlock, incomingBlock, movedBlocks, movedPeer, teleportStateOf } from "./teleportState";
import { lockChat, unlockChat } from "./teleportLock";

export interface LocalChatPort {
  get(id: string): Promise<Session | null>;
  put(session: Session): Promise<void>;
}

const RUNS_HERE: readonly string[] = ["claude", "codex"];
const MOVE_NOTICE = /^teleport-(frozen|incoming)-/;

/** The chat's saved messages, without this module's own notices. */
function savedBlocks(session: Session): Block[] {
  return session.blocks.filter((block) => !MOVE_NOTICE.test(block.id));
}

/** A desktop chat as a move's chat. The transcript is the chat's saved messages as JSON text. */
export function sessionToChat(session: Session): ChatSnapshot {
  return {
    chatId: session.id,
    provider: session.harness as Provider,
    providerSessionId: session.providerSessionId ?? "",
    model: session.model,
    effort: session.modelSettings?.effort ?? "",
    title: session.title,
    transcript: JSON.stringify(savedBlocks(session)),
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

function withBlocks(session: Session, blocks: Block[]): Session {
  return { ...session, blocks } as Session;
}

/**
 * This Mac as a move endpoint. The chat is live here while its row is not moved away. A freeze, an incoming copy and
 * the released marker are notices in the row, so each survives a restart.
 */
export function localMoveEndpoint(options: {
  machineId: string;
  port: LocalChatPort;
  /** The name a person sees for a machine id (the host's name). Defaults to the id. */
  labelFor?: (machineId: string) => string;
}): MoveEndpoint {
  const { machineId, port } = options;
  const labelFor = options.labelFor ?? ((id: string) => id);
  return {
    id: machineId,
    async read(chatId): Promise<ChatRecord | null> {
      const session = await port.get(chatId);
      if (!session) return null;
      // A Mono's saved transcript holds only its last turns, so a move would lose the rest. Refused, not shortened.
      if (session.monoTranscript) throw new Error("Mono chats cannot move yet: their saved transcript is only the last turns");
      const state = teleportStateOf(session);
      if (state.moved) return { owner: state.host, live: null };
      return { owner: machineId, live: sessionToChat(session) };
    },
    async freeze(chatId, moveId, peer) {
      const session = await port.get(chatId);
      if (!session || teleportStateOf(session).moved) return false;
      if (frozenMoves(session.blocks).length > 0) return false;
      await port.put(withBlocks(session, [...session.blocks, frozenBlock(moveId, peer)]));
      lockChat(chatId);
      return true;
    },
    async thaw(chatId, moveId) {
      const session = await port.get(chatId);
      if (!session || !hasBlock(session.blocks, `teleport-frozen-${moveId}`)) return;
      const blocks = session.blocks.filter((b) => b.id !== `teleport-frozen-${moveId}`);
      await port.put(withBlocks(session, blocks));
      // Unlock only when nothing else holds the chat: a moved chat or another freeze keeps it locked.
      if (!chatLockedFromBlocks(blocks)) unlockChat(chatId);
    },
    async canResume(provider, model, effort): Promise<CanResume> {
      if (!RUNS_HERE.includes(provider)) return { ok: false, reason: `this machine does not run ${provider}` };
      if (!model || !effort) return { ok: false, reason: "the chat has no model or effort to resume with" };
      return { ok: true };
    },
    async receive(chatId, moveId, payload): Promise<ReceiveReply> {
      const session = await port.get(chatId);
      if (!session) throw new Error("No saved chat row here to receive the move into");
      if (payload.chat.chatId !== chatId) throw new Error("The move names a different chat than the one being moved");
      // Only a chat that was moved away from here takes a copy back, and only from the machine it went to.
      if (!teleportStateOf(session).moved) throw new Error("This chat is not moved away from here, so a copy would overwrite live work");
      if (movedPeer(session) !== payload.manifest.from) throw new Error("This chat went to another machine, so its copy is refused");
      if (session.blocks.some((b) => b.notice === "teleport-incoming" && b.id !== `teleport-incoming-${moveId}`)) {
        return { ok: false, reason: "held" };
      }
      await port.put(withBlocks(session, [...session.blocks.filter((b) => b.id !== `teleport-incoming-${moveId}`), incomingBlock(moveId, JSON.stringify(payload.chat))]));
      return { ok: true, transcriptSha256: await sha256Hex(payload.chat.transcript) };
    },
    async discard(chatId, moveId) {
      const session = await port.get(chatId);
      if (!session || !hasBlock(session.blocks, `teleport-incoming-${moveId}`)) return;
      await port.put(withBlocks(session, session.blocks.filter((b) => b.id !== `teleport-incoming-${moveId}`)));
    },
    async activate(chatId, moveId) {
      const session = await port.get(chatId);
      if (!session) throw new Error("No saved chat row here to open the move in");
      if (hasBlock(session.blocks, `teleported-back-${moveId}`)) return;
      const copy = session.blocks.find((b) => b.id === `teleport-incoming-${moveId}`);
      if (!copy) throw new Error("No copy of this chat is stored here to open");
      const chat = JSON.parse(copy.text) as TransferChat;
      // The host's session id and its move notices are not trusted: the copy keeps the saved messages only.
      const saved = (JSON.parse(chat.transcript) as Block[]).filter((b) => !MOVE_NOTICE.test(b.id) && !(b.notice ?? "").startsWith("teleport"));
      const returned = {
        id: `teleported-back-${moveId}`,
        role: "system",
        text: `Moved back to this Mac`,
        notice: "teleported-back",
        startedAt: Date.now(),
      } as unknown as Block;
      await port.put({
        ...session,
        harness: chat.provider,
        model: chat.model,
        modelSettings: chat.effort ? { effort: chat.effort } : {},
        title: chat.title,
        providerSessionId: undefined,
        queuedMessages: chat.queued.map((text, index) => ({ id: `${chat.chatId}-queued-${index}`, text, attachments: [] })),
        blocks: [...saved, returned],
      } as unknown as Session);
      unlockChat(chatId);
    },
    async release(chatId, moveId, to) {
      const session = await port.get(chatId);
      if (!session || !hasBlock(session.blocks, `teleport-frozen-${moveId}`)) {
        throw new Error("This move did not freeze the chat");
      }
      // The transcript and the provider session id leave this Mac here: the host holds the live copy.
      await port.put({
        ...session,
        blocks: movedBlocks(labelFor(to), new Date().toISOString(), to),
        providerSessionId: undefined,
        queuedMessages: [],
      } as unknown as Session);
      lockChat(chatId);
    },
    async holds(chatId, moveId): Promise<Holds> {
      const session = await port.get(chatId);
      if (!session) return "none";
      if (hasBlock(session.blocks, `teleported-back-${moveId}`)) return "live";
      if (hasBlock(session.blocks, `teleport-incoming-${moveId}`)) return "incoming";
      return "none";
    },
  };
}

export { recapForRefusal } from "./teleportRecap";
