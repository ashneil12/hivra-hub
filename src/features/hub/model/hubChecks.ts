// Checks reach the chat that owns one of Ash's messages (docs/PHASE-2-DESIGN.md, decision 4 and H6).
//
// WP-04: Ash OS is retired, so no checks arrive until WP-14's decision store (localHub/decisions.ts); the history below
// is how they were delivered, and a check's own prompt is used as given. The owner answers in its reply ("Right: ...",
// "Fixed: ..."), with no Ash OS tools.
//
// The checker (hubChecker.ts) leaves its findings in Ash OS. The hub store pulls the ones not yet delivered
// (`checks`, on feed topic `checks` and at boot) and the app hands each to its owner's chat as one
// `[MonoCode check]` turn (app/hooks/useHubChecks.ts):
// - only when that chat is idle, with nothing queued and nothing waiting on Ash: a check never interrupts or steers;
// - once per check: the turn carries the receipt `mono-check-<id>`, so a check pulled again (a restart before Ash OS
//   heard it was delivered) is only confirmed, never sent twice;
// - then `check-delivered`. The owner answers with ash_record {check: {id, verdict: right|fixed, note}};
// - the chat shows it as a quiet collapsed card (hub/ui/CheckTurnCard.tsx): never as Ash's words, never on Today, no
//   unread count and no notification.
// A check for a chat outside the hub has nothing to deliver here: Ash OS hands it back on that chat's own next Ash OS
// call. Ash OS lists only checks for chats the app runs; one naming a chat this app doesn't have is left alone too.
import { heldFor } from "../../sessions/model/chatHold";
import type { Block, MonoCheck, Session } from "../../sessions/model/session";
import { claimEvidenceOf, lastReply, type ClaimEvidence } from "./claimEvidence";
import { CHECKER_MONO_ID } from "./hubMcp";
import { forUser } from "./userName";

/** Every check turn starts with this, so nothing takes it for Ash's own words (the studio's sweep skips it). */
export const CHECK_PREFIX = "[MonoCode check]";

/** One check as `checks` lists it. */
export type HubCheck = {
  id: string;
  dumpId: string;
  owner: string;
  monoId?: string;
  chatId?: string;
  providerSession?: string;
  finding: string;
  askIds: string[];
  createdAt?: string;
  saidAt?: string;
  /** The turn to queue, as Ash OS wrote it. */
  prompt: string;
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A turn of our own when Ash OS sent none (it always does): the same answer instruction. */
function fallbackPrompt(id: string, dumpId: string, finding: string): string {
  return forUser`${CHECK_PREFIX} The checker looked at Ash's message (dump ${dumpId}) that this chat owns and found: ${finding}\nLook at it here (check ${id}). If it was handled right as it is, start your reply with "Right:" and say why. If not, fix it first, then start your reply with "Fixed:" and say what you did.`;
}

export function mapCheck(raw: unknown): HubCheck | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const id = str(v.id);
  const dumpId = str(v.dumpId);
  const finding = str(v.finding);
  if (!id || !ID.test(id) || !dumpId || !finding) return undefined;
  const prompt = str(v.prompt);
  return {
    id,
    dumpId,
    owner: str(v.owner) ?? "",
    ...(str(v.monoId) ? { monoId: str(v.monoId) } : {}),
    ...(str(v.chatId) ? { chatId: str(v.chatId) } : {}),
    ...(str(v.providerSession) ? { providerSession: str(v.providerSession) } : {}),
    finding,
    askIds: Array.isArray(v.askIds) ? v.askIds.filter((a): a is string => typeof a === "string") : [],
    ...(str(v.createdAt) ? { createdAt: str(v.createdAt) } : {}),
    ...(str(v.saidAt) ? { saidAt: str(v.saidAt) } : {}),
    prompt: prompt?.startsWith(CHECK_PREFIX) ? prompt : fallbackPrompt(id, dumpId, finding),
  };
}

/** `checks`' answer, oldest first, each check once. */
export function mapChecks(raw: unknown): HubCheck[] {
  const list = raw && typeof raw === "object" ? (raw as { checks?: unknown }).checks : undefined;
  const seen = new Set<string>();
  const out: HubCheck[] = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const check = mapCheck(entry);
    if (!check || seen.has(check.id)) continue;
    seen.add(check.id);
    out.push(check);
  }
  return out;
}

/** The receipt a check's turn carries (its user block's appRequestId). */
export function checkReceipt(id: string): string {
  return `mono-check-${id}`;
}

/** What the turn's user block keeps for its card. */
export function checkMeta(check: HubCheck): MonoCheck {
  return { id: check.id, dumpId: check.dumpId, finding: check.finding.slice(0, 1_000) };
}

/** Where a check goes in this app: a Mono's chat (made if it has none yet), or a hub chat by its id. */
export type CheckTarget = { mono: string } | { session: string };

/**
 * A Mono's check goes to its current chat (a rotated Mono's old chat id is history); a plain hub chat's to that chat.
 * Never the checker itself or a worker (Ash OS never makes either an owner). Undefined: nothing to deliver here.
 */
export function checkTarget(check: HubCheck, monoExists: (id: string) => boolean): CheckTarget | undefined {
  if (check.monoId) {
    if (check.monoId === CHECKER_MONO_ID) return undefined;
    if (monoExists(check.monoId)) return { mono: check.monoId };
  }
  if (check.chatId && !check.chatId.startsWith("app-")) return { session: check.chatId };
  return undefined;
}

/** Whether this chat already has the check's turn (delivered before a restart, or this very moment). */
export function hasCheck(session: Pick<Session, "blocks" | "queuedMessages">, id: string): boolean {
  const receipt = checkReceipt(id);
  return (
    session.blocks.some((block) => block.appRequestId === receipt || block.monoCheck?.id === id) ||
    !!session.queuedMessages?.some((message) => message.id === receipt)
  );
}

/**
 * A chat takes a check only when it is idle and nothing else is waiting: nothing queued (Ash's own messages go first)
 * and none of `WAITS_ON.check` (chatHold.ts): no turn running or cut, no question or approval open, no usage limit, no
 * worktree, handoff or harness change on the way.
 */
export function takesCheck(session: Session): boolean {
  return !session.queuedMessages?.length && !heldFor(session, "check");
}

/** The turn now running (or last run) in this chat is a check. */
export function inCheckTurn(session: Pick<Session, "blocks">): boolean {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (block.role !== "user" || block.draft) continue;
    // A message Ash sent into the running check turn makes the rest of it his.
    return !!block.internal && !!block.monoCheck;
  }
  return false;
}

/**
 * The busy chats whose turn is not a check: a chat answering the checker never counts as a reply Ash hasn't read. The
 * same set comes back when nothing is answering a check, so callers that compare by identity see no change.
 */
export function withoutCheckTurns(busy: Set<string>, sessions: readonly Session[]): Set<string> {
  const quiet = sessions.filter((session) => busy.has(session.id) && inCheckTurn(session)).map((s) => s.id);
  if (!quiet.length) return busy;
  const next = new Set(busy);
  for (const id of quiet) next.delete(id);
  return next;
}

/**
 * A Mono's chat answering a room (its last turn came in as a room wake, monoNote kind "room"): the reply is the room's,
 * not one Ash hasn't read in this chat (r52: ed's badge stayed at 1 after a room turn that posted nothing there).
 */
export function inRoomTurn(session: Pick<Session, "blocks">): boolean {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (block.role !== "user" || block.draft) continue;
    return block.monoNote?.kind === "room";
  }
  return false;
}

/** The busy chats whose turn is neither a check nor a room's: the same set back when there are none. */
export function withoutQuietTurns(busy: Set<string>, sessions: readonly Session[]): Set<string> {
  const checked = withoutCheckTurns(busy, sessions);
  const quiet = sessions.filter((session) => checked.has(session.id) && inRoomTurn(session)).map((s) => s.id);
  if (!quiet.length) return checked;
  const next = new Set(checked);
  for (const id of quiet) next.delete(id);
  return next;
}

/** How the chat answered, for its card: from its ash_record call, else how its reply starts ("Right: ...", "Fixed: ..."). */
export function checkVerdict(turn: readonly Block[]): "right" | "fixed" | undefined {
  for (const block of turn) {
    if (!block.tool) continue;
    const seen = JSON.stringify(block.tool).match(/verdict\W{1,8}(right|fixed)\b/i);
    if (seen) return seen[1].toLowerCase() as "right" | "fixed";
  }
  for (let i = turn.length - 1; i > 0; i--) {
    const block = turn[i];
    if (block.role !== "assistant" || block.tool || !block.text.trim()) continue;
    const word = block.text.trim().match(/^\W*(right|fixed)\b/i);
    return word ? (word[1].toLowerCase() as "right" | "fixed") : undefined;
  }
  return undefined;
}

/**
 * What a "fixed" answer is worth, from the turn's own tool runs (claimEvidence.ts, board I5): a test or type check it
 * ran and that passed is verified; checks it only names are likely; anything else is a guess, which the card shows as
 * not proven. Undefined when the chat made no done/fixed claim.
 */
export function checkClaim(turn: readonly Block[]): ClaimEvidence | undefined {
  return claimEvidenceOf(lastReply(turn), turn);
}

/** What delivery needs from the app (app/hooks/useHubChecks.ts). */
export type CheckDeliveryHost = {
  /** The chat a target is, open in this window (a Mono with no chat yet gets one); undefined when this app has none. */
  open(target: CheckTarget): Promise<Session | undefined>;
  /** The chat as the app has it right now. */
  current(sessionId: string): Session | undefined;
  /** Send the check's turn: a hidden, internal user turn with the check's receipt. Resolves whether it was taken. */
  submit(sessionId: string, check: HubCheck): Promise<boolean>;
  /** `check-delivered`. */
  delivered(ids: string[]): Promise<void>;
  monoExists(id: string): boolean;
  now?(): number;
};

/**
 * The checks waiting for their chats. Each pull from Ash OS offers the undelivered ones; every change to the chats
 * flushes: a check goes to its chat once that chat is idle, one check per chat at a time, and is confirmed to Ash OS
 * once the turn is in (or found already in, after a restart). A check with nowhere to go here is dropped from the wait;
 * Ash OS keeps it, and offers it again with the next pull.
 */
export class CheckDelivery {
  private readonly pending = new Map<string, { check: HubCheck; retryAt: number }>();
  private running = false;
  private again = false;

  constructor(
    private readonly host: CheckDeliveryHost,
    private readonly retryMs = 30_000,
  ) {}

  /** The checks Ash OS has not heard delivered. */
  offer(checks: readonly HubCheck[]): Promise<void> {
    for (const check of checks) if (!this.pending.has(check.id)) this.pending.set(check.id, { check, retryAt: 0 });
    return this.flush();
  }

  waiting(): string[] {
    return [...this.pending.keys()];
  }

  async flush(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<void> {
    const now = this.host.now?.() ?? Date.now();
    const served = new Set<string>();
    for (const [id, entry] of [...this.pending]) {
      if (entry.retryAt > now) continue;
      const target = checkTarget(entry.check, (mono) => this.host.monoExists(mono));
      const opened = target ? await this.host.open(target).catch(() => undefined) : undefined;
      if (!opened) {
        this.pending.delete(id);
        continue;
      }
      const chat = this.host.current(opened.id) ?? opened;
      if (hasCheck(chat, id)) {
        await this.confirm(id);
        continue;
      }
      if (served.has(chat.id) || !takesCheck(chat)) continue;
      served.add(chat.id);
      const taken = await this.host.submit(chat.id, entry.check).catch(() => false);
      if (taken) await this.confirm(id);
      else entry.retryAt = now + this.retryMs;
    }
  }

  private async confirm(id: string): Promise<void> {
    this.pending.delete(id);
    // A failed confirmation is harmless: Ash OS offers the check again, and its receipt stops a second turn.
    await this.host.delivered([id]).catch(() => undefined);
  }
}
