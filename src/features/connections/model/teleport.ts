// Moving a chat between this Mac and a host the person has added (WP-177).
//
// A move is a custody handover, not a copy. The source freezes the chat. The target takes it under a lease and
// keeps the copy as incoming, which does not run. The target proves its copy matches the transcript. Only then
// does the source let go, and only then does the target open the chat. So the chat is never running on both
// sides, and any failure before the source lets go leaves the chat where it was.
//
// Nothing here starts a move by itself. A move needs the person's approval of a plan (planMove), and the plan id
// must still match when the move runs. The manifest and the payload are built from an allow list, so no login,
// key or token from either machine can ride along. The transport (the SSH host) is a MoveEndpoint supplied by the
// caller; this module has no network, no timers and no listener.

export type Provider = "claude" | "codex";

/** What a move carries of a chat. The transcript is the provider's own history, copied as it is. */
export interface ChatSnapshot {
  chatId: string;
  provider: Provider;
  providerSessionId: string;
  model: string;
  effort: string;
  title: string;
  transcript: string;
  queued: readonly string[];
  turnRunning: boolean;
  approvalPending: boolean;
}

/** The fields a target receives. Built by allow list, never by copying the whole chat. */
export type TransferChat = Pick<
  ChatSnapshot,
  "chatId" | "provider" | "providerSessionId" | "model" | "effort" | "title" | "transcript" | "queued"
>;

/** Who holds a chat, and its live copy if this machine is the one that runs it. */
export interface ChatRecord {
  owner: string;
  live: ChatSnapshot | null;
}

export interface Manifest {
  format: "hivra-teleport-v1";
  moveId: string;
  chatId: string;
  provider: Provider;
  providerSessionId: string;
  model: string;
  effort: string;
  title: string;
  queuedCount: number;
  transcriptBytes: number;
  transcriptSha256: string;
  from: string;
  to: string;
  at: string;
}

export interface MovePayload {
  manifest: Manifest;
  chat: TransferChat;
}

export type CanResume = { ok: true } | { ok: false; reason: string };
export type ReceiveReply = { ok: true; transcriptSha256: string } | { ok: false; reason: "held" };

/**
 * Lease for a chat on one machine (WP-60). On the host this is the session lease file, which refuses a second
 * holder while the first is alive. A holder that died counts as released.
 */
export interface LeasePort {
  acquire(chatId: string, holder: string): boolean;
  release(chatId: string, holder: string): void;
}

/**
 * One machine's side of a move. The source uses read, freeze, thaw and release. The target uses canResume,
 * receive, discard and activate. Every write names the move, so a late or repeated call cannot touch another
 * move's copy.
 */
export interface MoveEndpoint {
  readonly id: string;
  read(chatId: string): Promise<ChatRecord | null>;
  /** Stop new turns on this chat. False when another move already froze it. */
  freeze(chatId: string, moveId: string): Promise<boolean>;
  thaw(chatId: string, moveId: string): Promise<void>;
  canResume(provider: Provider, model: string, effort: string): Promise<CanResume>;
  /** Store the copy as incoming (it does not run) and take the lease. */
  receive(chatId: string, moveId: string, payload: MovePayload): Promise<ReceiveReply>;
  /** Remove an incoming copy this move stored. Nothing else is touched. */
  discard(chatId: string, moveId: string): Promise<void>;
  /** Turn the incoming copy into the live one, owned here. Idempotent. */
  activate(chatId: string, moveId: string): Promise<void>;
  /** Drop this machine's live copy and record the new owner. Only after the target confirmed. */
  release(chatId: string, moveId: string, to: string): Promise<void>;
}

export interface FreezeRefusal {
  reason: "turn-running" | "approval-pending";
  message: string;
  offer: "finish-then-move";
}

export type MoveRefusalReason =
  | "turn-running"
  | "approval-pending"
  | "approval-missing"
  | "approval-stale"
  | "not-found"
  | "not-owner"
  | "cannot-resume"
  | "held-elsewhere"
  | "state-changed";

export interface MoveRefusal {
  reason: MoveRefusalReason;
  message: string;
  recapOffered?: boolean;
}

export interface MovePlan {
  planId: string;
  chatId: string;
  from: string;
  to: string;
  provider: Provider;
  model: string;
  effort: string;
  title: string;
  queuedCount: number;
  transcriptSha256: string;
}

export type MoveStage = "read" | "freeze" | "resume-check" | "manifest" | "receive" | "verify" | "release";

export type MoveResult =
  | { status: "moved"; chatId: string; to: string; from?: string; manifest?: Manifest }
  | { status: "refused"; refusal: MoveRefusal }
  | { status: "failed"; stage: MoveStage; message: string; chatStayedOn: string }
  | { status: "partial"; stage: "activate"; chatId: string; to: string; moveId: string; message: string };

export interface MoveInput {
  chatId: string;
  from: MoveEndpoint;
  to: MoveEndpoint;
  approval: { planId: string } | null | undefined;
  moveId: string;
  at: string;
}

const FREEZE_COPY: Record<FreezeRefusal["reason"], string> = {
  "turn-running": "This chat is still working on a turn. It can move once that turn finishes.",
  "approval-pending": "This chat is waiting for your approval. Answer it, and then it can move.",
};

const MANIFEST_FIELDS = [
  "at",
  "chatId",
  "effort",
  "format",
  "from",
  "model",
  "moveId",
  "provider",
  "providerSessionId",
  "queuedCount",
  "title",
  "to",
  "transcriptBytes",
  "transcriptSha256",
] as const;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\.credentials\.json|\bauth\.json\b|\bkeychain\b/i,
];

/** Why a chat that is running or waiting cannot move yet. Null when it can move now. */
export function freezeRefusal(chat: Pick<ChatSnapshot, "turnRunning" | "approvalPending">): FreezeRefusal | null {
  if (chat.turnRunning) return { reason: "turn-running", message: FREEZE_COPY["turn-running"], offer: "finish-then-move" };
  if (chat.approvalPending) {
    return { reason: "approval-pending", message: FREEZE_COPY["approval-pending"], offer: "finish-then-move" };
  }
  return null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pickTransferChat(chat: ChatSnapshot): TransferChat {
  return {
    chatId: chat.chatId,
    provider: chat.provider,
    providerSessionId: chat.providerSessionId,
    model: chat.model,
    effort: chat.effort,
    title: chat.title,
    transcript: chat.transcript,
    queued: [...chat.queued],
  };
}

/** The manifest, from an allow list only. The transcript goes in the payload, never in the manifest. */
export function buildManifest(
  chat: ChatSnapshot,
  opts: { moveId: string; from: string; to: string; at: string; transcriptSha256: string },
): Manifest {
  return {
    format: "hivra-teleport-v1",
    moveId: opts.moveId,
    chatId: chat.chatId,
    provider: chat.provider,
    providerSessionId: chat.providerSessionId,
    model: chat.model,
    effort: chat.effort,
    title: chat.title,
    queuedCount: chat.queued.length,
    transcriptBytes: new TextEncoder().encode(chat.transcript).length,
    transcriptSha256: opts.transcriptSha256,
    from: opts.from,
    to: opts.to,
    at: opts.at,
  };
}

/** Throws if the manifest has a field outside the allow list, or a value that looks like a secret. */
export function assertManifestClean(manifest: Manifest): void {
  const allowed: readonly string[] = MANIFEST_FIELDS;
  for (const key of Object.keys(manifest)) {
    if (!allowed.includes(key)) throw new Error(`The move manifest has a field this move does not allow: ${key}`);
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (typeof value !== "string") continue;
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`The move manifest value for ${key} looks like a secret, so the move was stopped`);
    }
  }
}

async function buildPayload(
  chat: ChatSnapshot,
  opts: { moveId: string; from: string; to: string; at: string },
): Promise<MovePayload> {
  const transcriptSha256 = await sha256Hex(chat.transcript);
  const manifest = buildManifest(chat, { ...opts, transcriptSha256 });
  return { manifest, chat: pickTransferChat(chat) };
}

/**
 * The plan the person approves before anything moves. Refused (with the reason) when the chat cannot move now, so
 * nobody is asked to approve a move that cannot happen.
 */
export async function planMove(
  chat: ChatSnapshot,
  from: string,
  to: string,
): Promise<{ ok: true; plan: MovePlan } | { ok: false; refusal: MoveRefusal }> {
  const frozen = freezeRefusal(chat);
  if (frozen) return { ok: false, refusal: { reason: frozen.reason, message: frozen.message } };
  const transcriptSha256 = await sha256Hex(chat.transcript);
  const basis = {
    chatId: chat.chatId,
    from,
    to,
    provider: chat.provider,
    model: chat.model,
    effort: chat.effort,
    title: chat.title,
    queuedCount: chat.queued.length,
    transcriptSha256,
  };
  const planId = await sha256Hex(JSON.stringify(basis));
  return { ok: true, plan: { planId, ...basis } };
}

const noop = () => undefined;

function refuse(reason: MoveRefusalReason, message: string, recapOffered?: boolean): MoveResult {
  return { status: "refused", refusal: recapOffered ? { reason, message, recapOffered } : { reason, message } };
}

function failed(stage: MoveStage, chatStayedOn: string, error: unknown): MoveResult {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", stage, message, chatStayedOn };
}

/**
 * Hand a chat from one machine to the other. Returns what happened; on every result except "partial" the chat is
 * live on exactly one machine, the one it was on before, or the one it moved to.
 */
export async function moveChat(input: MoveInput): Promise<MoveResult> {
  const { chatId, from, to, approval, moveId, at } = input;
  if (!approval) return refuse("approval-missing", "Ask the person to approve this move first.");

  let record: ChatRecord | null;
  try {
    record = await from.read(chatId);
  } catch (error) {
    return failed("read", from.id, error);
  }
  if (!record) return refuse("not-found", "This chat is not on this machine.");
  if (record.owner !== from.id) return refuse("not-owner", `This chat is on ${record.owner}, not on this machine.`);
  if (!record.live) return refuse("not-found", "This chat is not live on this machine.");

  const planned = await planMove(record.live, from.id, to.id);
  if (!planned.ok) return { status: "refused", refusal: planned.refusal };
  if (planned.plan.planId !== approval.planId) {
    return refuse("approval-stale", "The chat changed after you approved the move. Review it again.");
  }

  let resume: CanResume;
  try {
    resume = await to.canResume(record.live.provider, record.live.model, record.live.effort);
  } catch (error) {
    return failed("resume-check", from.id, error);
  }
  if (!resume.ok) {
    return refuse(
      "cannot-resume",
      `The other machine cannot resume this chat's transcript: ${resume.reason}. Start a new chat from a recap instead.`,
      true,
    );
  }

  let frozen: boolean;
  try {
    frozen = await from.freeze(chatId, moveId);
  } catch (error) {
    await from.thaw(chatId, moveId).catch(noop);
    return failed("freeze", from.id, error);
  }
  if (!frozen) {
    return refuse("held-elsewhere", "Another move or a resume already holds this chat. Its result shows when it finishes.");
  }
  const undoFreeze = () => from.thaw(chatId, moveId).catch(noop);

  let payload: MovePayload;
  try {
    // Re-read under the freeze: the copy is the one that is frozen, not the one read before it.
    const now = await from.read(chatId);
    if (!now || now.owner !== from.id || !now.live) {
      await undoFreeze();
      return refuse("state-changed", "The chat changed while the move started. Review it again.");
    }
    const again = await planMove(now.live, from.id, to.id);
    if (!again.ok) {
      await undoFreeze();
      return { status: "refused", refusal: again.refusal };
    }
    if (again.plan.planId !== approval.planId) {
      await undoFreeze();
      return refuse("approval-stale", "The chat changed after you approved the move. Review it again.");
    }
    payload = await buildPayload(now.live, { moveId, from: from.id, to: to.id, at });
    assertManifestClean(payload.manifest);
  } catch (error) {
    await undoFreeze();
    return failed("manifest", from.id, error);
  }

  let received: ReceiveReply;
  try {
    received = await to.receive(chatId, moveId, payload);
  } catch (error) {
    await to.discard(chatId, moveId).catch(noop);
    await undoFreeze();
    return failed("receive", from.id, error);
  }
  if (!received.ok) {
    await undoFreeze();
    return refuse("held-elsewhere", "Another move or a resume already holds this chat. Its result shows when it finishes.");
  }
  if (received.transcriptSha256 !== payload.manifest.transcriptSha256) {
    await to.discard(chatId, moveId).catch(noop);
    await undoFreeze();
    return failed("verify", from.id, new Error("The copy on the other machine does not match the transcript. Nothing moved."));
  }

  try {
    await from.release(chatId, moveId, to.id);
  } catch (error) {
    await to.discard(chatId, moveId).catch(noop);
    await undoFreeze();
    return failed("release", from.id, error);
  }

  try {
    await to.activate(chatId, moveId);
  } catch (error) {
    // The source has let go, so the chat runs nowhere until the target opens it. completeMove retries that step.
    return {
      status: "partial",
      stage: "activate",
      chatId,
      to: to.id,
      moveId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { status: "moved", chatId, from: from.id, to: to.id, manifest: payload.manifest };
}

/** Retry the target's open step of a partial move. Idempotent: an already open chat is reported as moved. */
export async function completeMove(input: { chatId: string; to: MoveEndpoint; moveId: string }): Promise<MoveResult> {
  const { chatId, to, moveId } = input;
  try {
    await to.activate(chatId, moveId);
  } catch (error) {
    return { status: "partial", stage: "activate", chatId, to: to.id, moveId, message: error instanceof Error ? error.message : String(error) };
  }
  return { status: "moved", chatId, from: "", to: to.id };
}
