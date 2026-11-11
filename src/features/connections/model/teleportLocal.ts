// This Mac's own chats as the other end of a move (WP-177). A desktop chat (a Session row) becomes the move's chat, and a
// moved copy becomes a Session row again. Every step a move takes here is saved in the chat row as a notice (the freeze,
// an incoming copy, the marker, a refused move id), so a restart or a crash still knows where the chat is. Each step is
// one write through the port, which the store checks itself (session_upsert's teleport guard), so two windows cannot both
// take the chat. Nothing here writes anything else.

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
import {
  abortedBlock,
  abortedMoves,
  chatLockedFromBlocks,
  freezeAskedBlock,
  frozenBlock,
  frozenMoves,
  hasBlock,
  incomingBlock,
  movedBlocks,
  movedPeer,
  savedIncoming,
  teleportStateOf,
} from "./teleportState";
import { lockChat, unlockChat } from "./teleportLock";
import { forgetHarnessSession } from "../../../integrations/harness/core/registry";
import { releaseOwedBlock } from "./teleportState";

/** The move steps the store checks. Each one may make only its own change to the row. */
export type MoveStepOp = "freeze" | "thaw" | "release" | "incoming" | "discard" | "activate" | "abort";

export type StepResult = { ok: true } | { ok: false; message: string };

export interface LocalChatPort {
  get(id: string): Promise<Session | null>;
  put(session: Session): Promise<void>;
  /**
   * One move step, saved by the store's own guard (WP-177). A step the store refuses for a conflict comes back as
   * `ok: false`, so a second window or a second move cannot take the chat. Without it, the step is a plain save.
   */
  step?(session: Session, step: { moveId: string; op: MoveStepOp }): Promise<StepResult>;
}

const RUNS_HERE: readonly string[] = ["claude", "codex"];
const MOVE_NOTICE = /^teleport-(frozen|incoming|aborted|release-owed|freeze-asked)-/;

/** The effort the chat actually stores. Codex keeps it as reasoningEffort; some models have none. */
function effortOf(settings: Session["modelSettings"] | undefined): string {
  if (!settings) return "";
  return settings.effort || settings.reasoningEffort || "";
}

/** Settings that are plain short strings. Anything else is dropped, not copied to the other machine. */
function carriedSettings(settings: Session["modelSettings"] | undefined): Record<string, string> | undefined {
  if (!settings) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== "string" || !value.trim() || value.length > 64) continue;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(key)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
/** A copy's transcript is capped here, so a host cannot push an unbounded row into this Mac's store. */
const MAX_TRANSCRIPT_CHARS = 64 * 1024 * 1024;

function unpredictableId(prefix: string): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  const uuid = cryptoRef?.randomUUID?.();
  if (uuid) return `${prefix}${uuid}`;
  const bytes = new Uint8Array(16);
  cryptoRef?.getRandomValues?.(bytes);
  if ([...bytes].some((byte) => byte !== 0)) {
    return prefix + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${prefix}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** The owner of this window's freezes: a freeze names the window that took it, so recovery never thaws another window's. */
export const WINDOW_OWNER: string = unpredictableId("window-");

/** A move id nobody can guess from the clock. */
export function newMoveId(): string {
  return unpredictableId("move-");
}

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
    effort: effortOf(session.modelSettings),
    ...(carriedSettings(session.modelSettings) ? { modelSettings: carriedSettings(session.modelSettings) } : {}),
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
    modelSettings: carriedSettings(chat.modelSettings) ?? (chat.effort ? { effort: chat.effort } : {}),
    runtimeMode: "default",
    title: chat.title,
    cwd: options.cwd,
    blocks: copyBlocks(chat.transcript),
    providerSessionId: chat.providerSessionId,
    queuedMessages: chat.queued.map((text, index) => ({ id: `${chat.chatId}-queued-${index}`, text, attachments: [] })),
  } as unknown as Session;
}

function withBlocks(session: Session, blocks: Block[]): Session {
  return { ...session, blocks } as Session;
}

const COPY_ROLES = new Set(["user", "assistant", "image", "reasoning", "tool", "approval", "tasks", "plan", "system", "handoff"]);
const COPY_NOTICES = new Set(["error", "interrupt", "recovered", "teleported", "teleported-back"]);

function copyString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, max);
}

function copyNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * One message from another machine, rebuilt from an allow-list. Fields that name this Mac's own runs, files or secrets
 * (a Lead, a crew note, an app request, an attachment path) are dropped. A message that is not a message is refused.
 */
function copyBlock(raw: unknown): Block {
  const candidate = raw as { id?: unknown; role?: unknown; text?: unknown } | null;
  if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string" || typeof candidate.role !== "string") {
    throw new Error("A message in the copy is not in the saved form, so nothing was opened");
  }
  if (!COPY_ROLES.has(candidate.role)) throw new Error("A message in the copy is not in the saved form, so nothing was opened");
  const source = raw as Record<string, unknown>;
  const block = {
    id: candidate.id.slice(0, 200),
    role: candidate.role,
    text: typeof candidate.text === "string" ? candidate.text : "",
  } as Block;
  const startedAt = copyNumber(source.startedAt);
  const durationMs = copyNumber(source.durationMs);
  const sentAt = copyNumber(source.sentAt);
  if (startedAt !== undefined) block.startedAt = startedAt;
  if (durationMs !== undefined) block.durationMs = durationMs;
  if (sentAt !== undefined) block.sentAt = sentAt;
  if (typeof source.notice === "string" && COPY_NOTICES.has(source.notice)) block.notice = source.notice as Block["notice"];
  if (source.tool && typeof source.tool === "object") {
    const tool = source.tool as Record<string, unknown>;
    const next: NonNullable<Block["tool"]> = {};
    const title = copyString(tool.title, 500);
    const kind = copyString(tool.kind, 80);
    const status = copyString(tool.status, 80);
    const command = copyString(tool.command, 20_000);
    if (title) next.title = title;
    if (kind) next.kind = kind;
    if (status) next.status = status;
    if (typeof tool.detail === "string") next.detail = tool.detail;
    if (tool.detailOmitted === true) next.detailOmitted = true;
    if (command) next.command = command;
    if (tool.background === true) next.background = true;
    const toolStarted = copyNumber(tool.startedAt);
    const toolUpdated = copyNumber(tool.updatedAt);
    if (toolStarted !== undefined) next.startedAt = toolStarted;
    if (toolUpdated !== undefined) next.updatedAt = toolUpdated;
    block.tool = next;
  }
  return block;
}

/**
 * The blocks a copy carries, checked before it is stored or opened (LOW). A copy comes from another machine, so it must be
 * a list of messages with string ids and roles. Anything else is refused whole, and nothing is opened.
 */
export function copyBlocks(transcript: string): Block[] {
  if (transcript.length > MAX_TRANSCRIPT_CHARS) throw new Error("The copy is too large to open here, so nothing was opened");
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcript);
  } catch {
    throw new Error("The copy's messages are not readable, so nothing was opened");
  }
  if (!Array.isArray(parsed)) throw new Error("The copy's messages are not a list, so nothing was opened");
  return parsed.map((block) => copyBlock(block));
}

/** The copy's chat fields, checked: a provider this Mac runs, a title, the queued texts. */
function copyChat(text: string): TransferChat {
  let chat: Partial<TransferChat>;
  try {
    chat = JSON.parse(text) as Partial<TransferChat>;
  } catch {
    throw new Error("The copy is not readable, so nothing was opened");
  }
  if (typeof chat.chatId !== "string" || typeof chat.transcript !== "string" || typeof chat.title !== "string") {
    throw new Error("The copy is missing its chat fields, so nothing was opened");
  }
  if (!Array.isArray(chat.queued) || chat.queued.some((item) => typeof item !== "string")) {
    throw new Error("The copy's queued messages are not in a form this Mac accepts, so nothing was opened");
  }
  copyBlocks(chat.transcript);
  return chat as TransferChat;
}

async function saveStep(port: LocalChatPort, session: Session, moveId: string, op: MoveStepOp): Promise<StepResult> {
  if (port.step) return port.step(session, { moveId, op });
  await port.put(session);
  return { ok: true };
}

async function mustStep(port: LocalChatPort, session: Session, moveId: string, op: MoveStepOp): Promise<void> {
  const result = await saveStep(port, session, moveId, op);
  if (!result.ok) throw new Error(result.message);
}

/**
 * This Mac as a move endpoint. The chat is live here while its row is not moved away. A freeze, an incoming copy, the
 * released marker and a refused move id are notices in the row, so each survives a restart.
 */
export function localMoveEndpoint(options: {
  machineId: string;
  port: LocalChatPort;
  /** The name a person sees for a machine id (the host's name). Defaults to the id. */
  labelFor?: (machineId: string) => string;
  /** The window that freezes chats through this endpoint (M1). Defaults to this window. */
  owner?: string;
  /** Time source for freeze records (tests). */
  now?: () => string;
}): MoveEndpoint {
  const { machineId, port } = options;
  const labelFor = options.labelFor ?? ((id: string) => id);
  const owner = options.owner ?? WINDOW_OWNER;
  const now = options.now ?? (() => new Date().toISOString());
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
      // Lock before the save, so a turn queued in this window cannot start while the freeze is being written.
      lockChat(chatId);
      const next = withBlocks(session, [...session.blocks, frozenBlock(moveId, peer, owner, now(), labelFor(peer))]);
      let result: StepResult;
      try {
        result = await saveStep(port, next, moveId, "freeze");
      } catch (error) {
        unlockChat(chatId);
        throw error;
      }
      // The store decides when two windows race: a refused freeze means another move holds the chat.
      if (!result.ok) {
        unlockChat(chatId);
        return false;
      }
      return true;
    },
    async thaw(chatId, moveId) {
      const session = await port.get(chatId);
      if (!session || !hasBlock(session.blocks, `teleport-frozen-${moveId}`)) return;
      const blocks = session.blocks.filter((b) => b.id !== `teleport-frozen-${moveId}`);
      await mustStep(port, withBlocks(session, blocks), moveId, "thaw");
      // Unlock only when nothing else holds the chat: a moved chat or another freeze keeps it locked.
      if (!chatLockedFromBlocks(blocks)) unlockChat(chatId);
    },
    // An empty effort is still a resume: Codex may have none, and the move carries whatever was saved.
    async canResume(provider, model, _effort): Promise<CanResume> {
      if (!RUNS_HERE.includes(provider)) return { ok: false, reason: `this machine does not run ${provider}` };
      if (!model) return { ok: false, reason: "the chat has no model to resume with" };
      return { ok: true };
    },
    async receive(chatId, moveId, payload): Promise<ReceiveReply> {
      const session = await port.get(chatId);
      if (!session) throw new Error("No saved chat row here to receive the move into");
      if (payload.chat.chatId !== chatId) throw new Error("The move names a different chat than the one being moved");
      // Only a chat that was moved away from here takes a copy back, and only from the machine it went to.
      if (!teleportStateOf(session).moved) throw new Error("This chat is not moved away from here, so a copy would overwrite live work");
      if (movedPeer(session) !== payload.manifest.from) throw new Error("This chat went to another machine, so its copy is refused");
      if (abortedMoves(session.blocks).includes(moveId)) throw new Error("This move was refused here, so its copy is turned away");
      copyChat(JSON.stringify(payload.chat));
      const kept = session.blocks.filter((b) => b.id !== `teleport-incoming-${moveId}`);
      const next = withBlocks(session, [...kept, incomingBlock(moveId, payload.manifest.from, JSON.stringify(payload.chat))]);
      const result = await saveStep(port, next, moveId, "incoming");
      if (!result.ok) return { ok: false, reason: "held" };
      return { ok: true, transcriptSha256: await sha256Hex(payload.chat.transcript) };
    },
    async discard(chatId, moveId) {
      const session = await port.get(chatId);
      if (!session || !hasBlock(session.blocks, `teleport-incoming-${moveId}`)) return;
      await mustStep(port, withBlocks(session, session.blocks.filter((b) => b.id !== `teleport-incoming-${moveId}`)), moveId, "discard");
    },
    async abort(chatId, moveId): Promise<"aborted" | "live"> {
      const session = await port.get(chatId);
      if (!session) return "aborted";
      if (hasBlock(session.blocks, `teleported-back-${moveId}`)) return "live";
      if (hasBlock(session.blocks, `teleport-aborted-${moveId}`)) return "aborted";
      // The refusal keeps the peer, so recovery can still tell that machine to thaw if it could not be told now.
      const peer = savedIncoming(session).find((copy) => copy.moveId === moveId)?.peer ?? "";
      const blocks = [...session.blocks.filter((b) => b.id !== `teleport-incoming-${moveId}`), abortedBlock(moveId, peer)];
      const result = await saveStep(port, withBlocks(session, blocks), moveId, "abort");
      if (!result.ok) {
        // The store refused the abort: the copy was opened in the meantime. Only the stored row can say which.
        const again = await port.get(chatId);
        if (again && hasBlock(again.blocks, `teleported-back-${moveId}`)) return "live";
        throw new Error(result.message);
      }
      return "aborted";
    },
    async activate(chatId, moveId) {
      const session = await port.get(chatId);
      if (!session) throw new Error("No saved chat row here to open the move in");
      if (hasBlock(session.blocks, `teleported-back-${moveId}`)) return;
      const copy = savedIncoming(session).find((c) => c.moveId === moveId);
      if (!copy) throw new Error("No copy of this chat is stored here to open");
      const chat = copyChat(copy.chat);
      // The host's session id and its move notices are not trusted: the copy keeps the saved messages only.
      const saved = copyBlocks(chat.transcript).filter((b) => !MOVE_NOTICE.test(b.id) && !(b.notice ?? "").startsWith("teleport"));
      const origin = labelFor(copy.peer);
      const returned = {
        id: `teleported-back-${moveId}`,
        role: "system",
        text: `Moved back to this Mac\nFrom: ${origin}`,
        notice: "teleported-back",
        startedAt: Date.now(),
      } as unknown as Block;
      // Drop the provider conversation this Mac had before the move, so the next turn does not resume it.
      await forgetHarnessSession(session.harness, chatId);
      const next = {
        ...session,
        harness: chat.provider,
        model: chat.model,
        modelSettings: carriedSettings(chat.modelSettings) ?? (chat.effort ? { effort: chat.effort } : {}),
        title: chat.title,
        providerSessionId: undefined,
        // Its next turn sends the chat so far with the text: the copy has no provider conversation here (movedChatPrompt).
        moveBriefOwed: true,
        movedFrom: origin,
        queuedMessages: chat.queued.map((text, index) => ({ id: `${chat.chatId}-queued-${index}`, text, attachments: [] })),
        // The release-owed note stays until the host confirms it dropped its copy (a failed release is recovered from it).
        blocks: [...saved, returned, releaseOwedBlock(moveId, copy.peer, origin)],
      } as unknown as Session;
      await mustStep(port, next, moveId, "activate");
      unlockChat(chatId);
    },
    async release(chatId, moveId, to) {
      const session = await port.get(chatId);
      if (!session || !hasBlock(session.blocks, `teleport-frozen-${moveId}`)) {
        throw new Error("This move did not freeze the chat");
      }
      // The provider conversation stays on this Mac otherwise, and a later move would resume it.
      await forgetHarnessSession(session.harness, chatId);
      // The assistant transcript and the provider session id leave this Mac: the host holds the live copy.
      // The person's own messages stay, so the row is still a chat in its project after a restart.
      const kept = session.blocks.filter((block) => block.role === "user" && block.draft !== true);
      const next = {
        ...session,
        blocks: [...kept, ...movedBlocks(labelFor(to), now(), to)],
        providerSessionId: undefined,
        queuedMessages: [],
      } as unknown as Session;
      await mustStep(port, next, moveId, "release");
      lockChat(chatId);
    },
    async settleRelease(chatId, moveId) {
      const session = await port.get(chatId);
      const id = `teleport-release-owed-${moveId}`;
      if (!session || !hasBlock(session.blocks, id)) return;
      // A plain save: the chat is already back, and dropping this note does not change who holds it.
      await port.put(withBlocks(session, session.blocks.filter((block) => block.id !== id)));
    },
    async noteFreezeAsk(chatId, moveId, sourceId) {
      const session = await port.get(chatId);
      if (!session) return;
      const id = `teleport-freeze-asked-${moveId}`;
      if (hasBlock(session.blocks, id)) return;
      // A plain save: the chat stays where it is. The note only remembers which move asked the other machine to freeze.
      await port.put(withBlocks(session, [...session.blocks, freezeAskedBlock(moveId, sourceId)]));
    },
    async clearFreezeAsk(chatId, moveId) {
      const session = await port.get(chatId);
      const id = `teleport-freeze-asked-${moveId}`;
      if (!session || !hasBlock(session.blocks, id)) return;
      await port.put(withBlocks(session, session.blocks.filter((block) => block.id !== id)));
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
