// Harness self-repair (board H1/H3; Ash, 14 Oct: "the harness looks after itself: errors it can see get fixed without
// Ash asking"). Self-repair (selfRepair.ts) covers a delegated worker that crashed or went quiet; this is the general
// half, for the chats the app itself runs: when a chat's own turn fails for a reason that may pass (a provider blip, a
// dropped stream, a timeout), the app tries it again by itself with backoff before anyone asks it to.
//
// It reads the failure the app already records on every chat (turnFailure.ts lastTurnFailure) on the stall watcher's
// half-minute look — no new measurement, no folder reads, no model. It never retries what a person must decide: a
// sign-in or billing refusal, a usage window before its reset, a chat with a question open, anything Ash stopped. It
// gives a fault two tries (a minute and five minutes after it went wrong), and a fresh failure in the same chat counts
// against the same tries until the chat has run cleanly for half an hour, so a failing loop can't retry for ever. When
// the tries run out it says so once, plainly, in that chat and stops: nothing keeps trying behind Ash's back.
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { lastTurnFailure, type TurnFailure } from "./turnFailure";
import { forUser } from "../../hub/model/userName";

const MIN = 60_000;
/** The wait before each try, from when the chat went wrong; its length is the number of tries. */
export const HARNESS_BACKOFF_MS: readonly number[] = [MIN, 5 * MIN];
/** A chat that has run cleanly this long starts a later fault with fresh tries. */
export const HARNESS_RESET_MS = 30 * MIN;
/** A failure this old is history, not a fault to replay (a restart doesn't re-run yesterday's turn). */
export const HARNESS_STALE_MS = 6 * 60 * MIN;
/** What one chat can hold; a bound so a pile-up of failures can't grow the map without limit. */
export const HARNESS_MAX_CHATS = 20;

/** One failed turn the app can see, as much of it as repair needs. */
export type HarnessFault = Pick<TurnFailure, "blockId" | "reason" | "retryable" | "resetsAt" | "errorClass" | "at"> & {
  sessionId: string;
  /** When it was first seen, for a failure that carries no time of its own. */
  seenAt: number;
};

export type HarnessRepairHost = {
  now?(): number;
  /** Try the chat's failed turn again — the same path as Try again. False when it can't right now (busy, gone). */
  retry(sessionId: string): boolean;
  /** One quiet app note in the chat itself (a hidden turn; never Ash's words). */
  note(sessionId: string, message: QueuedMessage): void | Promise<void>;
  backoffMs?: readonly number[];
};

type Repair = { episode: string; tries: number; nextAt: number; said: boolean; okSince?: number };

/**
 * Whether the app may retry this failure by itself. A passing provider fault or a busy server may clear; a refusal
 * (sign-in, billing), a usage window with a reset time, and anything a person set in motion may not.
 */
export function autoRepairable(fault: Pick<HarnessFault, "reason" | "retryable" | "resetsAt" | "errorClass">): boolean {
  if (fault.retryable === false) return false;
  // A refusal or a limit is a person's to fix: a key, a sign-in, a bill, a usage window. Autopilot or Ash resumes a
  // window; the app never spends one by itself.
  if (fault.errorClass && /^(auth|billing|usage_limit|rate_limit)$/.test(fault.errorClass)) return false;
  if (fault.resetsAt != null) return false;
  if (/\b(sign(ed)?[ -]?(in|out)|log(ged)?[ -]?(in|out)|api key|credentials?|auth|billing|credits?|payment|subscription|usage limit|out of usage|rate limit)\b/i.test(fault.reason))
    return false;
  return true;
}

/** The one quiet line a chat gets when the app stops trying: what failed, that it stopped, and what's left to do. */
export function harnessNoteMessage(sessionId: string, reason: string, at: number): QueuedMessage {
  const line = `This chat's turn failed (${reason}) and the app's ${HARNESS_BACKOFF_MS.length} automatic tries didn't clear it. It won't retry by itself again. Look at what went wrong and carry on, or say in one line what you need to be able to.`;
  return {
    id: `harness-repair-${sessionId}-${Math.floor(at / MIN)}`,
    attachments: [],
    monoNote: { kind: "message", from: "Self-repair", line: line.length > 160 ? `${line.slice(0, 159)}…` : line },
    text: forUser`[MonoCode self-repair] ${line} (this is the app, not Ash.)`,
  };
}

/** The chat's own failed turn, in repair's words. Undefined when it isn't failing or the app can't see it. */
export function faultOf(session: Pick<Session, "id" | "blocks" | "busy" | "usageLimit" | "worktreeRemoved">, seenAt: number): HarnessFault | undefined {
  const failure = lastTurnFailure(session);
  if (!failure) return undefined;
  return {
    sessionId: session.id,
    blockId: failure.blockId,
    reason: shortReason(failure.reason),
    retryable: failure.retryable,
    ...(failure.errorClass ? { errorClass: failure.errorClass } : {}),
    ...(failure.resetsAt != null ? { resetsAt: failure.resetsAt } : {}),
    ...(failure.at != null ? { at: failure.at } : {}),
    seenAt,
  };
}

const shortReason = (reason: string) => {
  const one = reason.trim().split("\n")[0] ?? "";
  return one.length > 120 ? `${one.slice(0, 119).trimEnd()}…` : one;
};

/**
 * One per main window, on the stall watcher's half-minute look. `tick` takes the chats' current failures; it acts on
 * the due ones and forgets the rest.
 */
export class HarnessRepair {
  private repairs = new Map<string, Repair>();
  private running = false;

  constructor(private host: HarnessRepairHost) {}

  private now() {
    return (this.host.now ?? Date.now)();
  }

  /** Tests: what it holds for a chat. */
  state(sessionId: string): Readonly<Repair> | undefined {
    return this.repairs.get(sessionId);
  }

  /** Act on this look's failures. Safe to call often; a retried chat is left alone until its backoff is up. */
  tick(faults: readonly HarnessFault[]): void {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      const backoff = this.host.backoffMs ?? HARNESS_BACKOFF_MS;
      const byChat = new Map<string, HarnessFault>();
      for (const fault of faults) if (!byChat.has(fault.sessionId)) byChat.set(fault.sessionId, fault);
      for (const [sessionId, repair] of [...this.repairs]) {
        const fault = byChat.get(sessionId);
        if (!fault) {
          // Clean again: after half an hour of it, a later failure starts over (a crash loop never does).
          repair.okSince ??= now;
          if (now - repair.okSince >= HARNESS_RESET_MS) this.repairs.delete(sessionId);
          continue;
        }
        delete repair.okSince;
        if (fault.blockId !== repair.episode) {
          // A new failed turn in the same chat: it waits its own backoff, and the tries carry on counting.
          repair.episode = fault.blockId;
          repair.nextAt = Math.max(repair.nextAt, (fault.at ?? now) + (backoff[Math.min(repair.tries, backoff.length - 1)] ?? 0));
        }
        this.act(sessionId, fault, repair, now, backoff);
      }
      for (const fault of byChat.values()) {
        if (this.repairs.has(fault.sessionId) || this.repairs.size >= HARNESS_MAX_CHATS) continue;
        const at = fault.at ?? fault.seenAt;
        // Seen for the first time: a fault older than the stale limit is history, not something to replay.
        const stale = now - at >= HARNESS_STALE_MS;
        const repair: Repair = { episode: fault.blockId, tries: stale ? backoff.length : 0, nextAt: at + (backoff[0] ?? 0), said: stale };
        this.repairs.set(fault.sessionId, repair);
        if (!stale) this.act(fault.sessionId, fault, repair, now, backoff);
      }
    } finally {
      this.running = false;
    }
  }

  private act(sessionId: string, fault: HarnessFault, repair: Repair, now: number, backoff: readonly number[]) {
    if (repair.said || now < repair.nextAt) return;
    if (!autoRepairable(fault)) {
      // Not the app's to retry: its own failure card (Needs you, Try again) already says what to do.
      repair.said = true;
      return;
    }
    if (repair.tries >= backoff.length) {
      repair.said = true;
      void this.host.note(sessionId, harnessNoteMessage(sessionId, fault.reason, now));
      return;
    }
    if (!this.host.retry(sessionId)) {
      // Busy or not loaded yet: look again on the next pass, without spending a try.
      repair.nextAt = now + 30_000;
      return;
    }
    repair.tries++;
    repair.nextAt = now + (backoff[repair.tries] ?? backoff[backoff.length - 1]);
  }
}
