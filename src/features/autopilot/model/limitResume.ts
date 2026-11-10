// Auto-resume at a usage-limit reset (the autopilot design notes; T3's
// UsageLimitRecoveryWorker). On by default for agents' chats (Monos, Leads and the work they delegate), with a
// per-project override; Ash's own chats keep the opt-in "Resume at reset" toggle. Not tied to the autopilot switch.
//
// Guards, from T3: a reset already past never arms; a chat with a question or approval pending, or whose checkout is
// gone, isn't armed; a newer message cancels the resume; at most MAX_AUTO_RESUMES in a row without a finished turn
// (the Rust row counts, so a crash doesn't reset it). Resumes are spread out: the leadership team first, then Leads,
// then everyone else, each with a little jitter, so a reset doesn't fire every chat in the same second.
//
// A chat's limit is in-memory only; the Rust row (`autopilot_resumes`) is what brings an armed resume back after a
// restart. `planResume` is the one step function the app hook runs per chat on every change.

import type { Session, UsageLimit } from "../../sessions/model/session";
import { hasPendingApproval } from "../../sessions/model/session";
import { USAGE_LIMIT_RESUME_GRACE_MS, usageLimitResumeAt } from "../../sessions/model/usageLimit";
import { formatUntil } from "./endTime";

export const RESUME_STAGGER_MS = 60_000;
export const RESUME_JITTER_MS = 45_000;
/** The same cap the Rust row enforces (autopilot.rs MAX_AUTO_RESUMES). */
export const MAX_AUTO_RESUMES = 3;
/** A resume that went out but whose turn we never saw (a restart in between) counts as finished after this. */
export const RESUMED_SETTLE_MS = 10 * 60_000;

export type ResumeRank = 0 | 1 | 2;

/** 0 the leadership team, 1 a Lead, 2 everyone else. */
export function resumeRank(monoId: string | undefined, isLeadership: (id: string) => boolean, isLead: (id: string) => boolean): ResumeRank {
  if (!monoId) return 2;
  if (isLeadership(monoId)) return 0;
  if (isLead(monoId)) return 1;
  return 2;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** When a chat resumes: the reset, the provider's grace, its rank's place in line and a stable jitter. */
export function resumeAtFor(sessionId: string, resetsAt: number, rank: ResumeRank): number {
  return resetsAt + USAGE_LIMIT_RESUME_GRACE_MS + rank * RESUME_STAGGER_MS + (hash(sessionId) % RESUME_JITTER_MS);
}

/** "Paused until 14:10" for an armed limit, else undefined. */
export function pausedLabel(limit: UsageLimit | undefined, now: number): string | undefined {
  if (!limit?.resumeAtReset) return undefined;
  const at = usageLimitResumeAt(limit);
  return at === undefined ? undefined : `Paused until ${formatUntil(at, now)}`;
}

/** Whether a chat may be armed at all (the per-session part; the hook adds agent ownership and the project setting). */
export function resumable(session: Pick<Session, "pendingQuestion" | "blocks" | "worktreeRemoved">): boolean {
  return !session.pendingQuestion && !session.worktreeRemoved && !hasPendingApproval(session.blocks);
}

/** What the app knows about one chat's auto-resume (mirrors the Rust row). */
export type Track = {
  state: "armed" | "resumed" | "gave_up";
  resetsAt: number;
  resumeAt: number;
  attempts: number;
  /** The armed limit is on the chat in this window (false right after a restart). */
  applied: boolean;
  /** A turn ran after the resume. */
  sawBusy: boolean;
  /** When this state began, for settling a resume whose turn we never saw. */
  since: number;
};

export type ResumeAction =
  | { type: "arm"; resetsAt: number; resumeAt: number }
  | { type: "apply"; resetsAt: number; resumeAt: number }
  | { type: "resumed" }
  | { type: "cancelled" }
  | { type: "finished" }
  | { type: "sawBusy" };

type Chat = Pick<Session, "usageLimit" | "busy" | "pendingQuestion" | "blocks" | "worktreeRemoved" | "id">;

/**
 * One step for one chat: what to do now, given the chat as it is and what we tracked. `eligible` is the hook's
 * answer to "is this an agent's chat with auto-resume on for its project".
 */
export function planResume(
  chat: Chat | undefined,
  track: Track | undefined,
  ctx: { now: number; eligible: boolean; rank: ResumeRank },
): ResumeAction | null {
  const limit = chat?.usageLimit;
  const fresh = () => {
    if (!chat || !limit || limit.resetsAt == null || !ctx.eligible || !resumable(chat)) return null;
    // T3: a reset already in the past can't start a retry loop.
    if (limit.resetsAt <= ctx.now) return null;
    return { type: "arm", resetsAt: limit.resetsAt, resumeAt: resumeAtFor(chat.id, limit.resetsAt, ctx.rank) } as const;
  };
  if (!track) {
    // Ash's own "Resume at reset" toggle already resumes it; leave his choice alone.
    if (limit?.resumeAtReset && !limit.auto) return null;
    return fresh();
  }
  if (!chat) return null;
  if (track.state === "armed") {
    if (limit) {
      if (limit.resetsAt != null && limit.resetsAt !== track.resetsAt) return fresh();
      if (limit.resumeAtReset) return null;
      // We put it on and it's off now: Ash turned it off.
      if (limit.auto) return { type: "cancelled" };
      return { type: "apply", resetsAt: track.resetsAt, resumeAt: track.resumeAt };
    }
    if (!track.applied) {
      // After a restart the chat comes back without its limit. Idle: put the armed limit back. Already running
      // (Ash or a Mono sent it something): that newer message wins.
      return chat.busy ? { type: "cancelled" } : { type: "apply", resetsAt: track.resetsAt, resumeAt: track.resumeAt };
    }
    // The limit went: our continue turn (its time had come), or a newer message before it.
    return ctx.now >= track.resumeAt - 5_000 ? { type: "resumed" } : { type: "cancelled" };
  }
  // Resumed, or given up and waiting for someone to resume it by hand.
  if (limit) return track.state === "resumed" ? fresh() : null;
  if (chat.busy) return track.sawBusy ? null : { type: "sawBusy" };
  if (track.sawBusy || ctx.now - track.since > RESUMED_SETTLE_MS) return { type: "finished" };
  return null;
}

/**
 * The app's answer to "will this chat resume by itself at its reset?", registered by the app hook. The completion
 * report reads it, so the Lead that delegated the work hears "paused until 14:10" instead of only "failed".
 */
let eligibleNow: ((session: Session) => boolean) | undefined;

export function setAutoResumeEligibility(fn: ((session: Session) => boolean) | undefined): () => void {
  eligibleNow = fn;
  return () => {
    if (eligibleNow === fn) eligibleNow = undefined;
  };
}

/** The reason a delegating Lead reads for a worker stopped at a limit that will resume by itself, else undefined. */
export function autoResumeReason(session: Session | undefined, resetsAt: number | undefined, now = Date.now()): string | undefined {
  if (!session || resetsAt == null || resetsAt <= now || !eligibleNow?.(session) || !resumable(session)) return undefined;
  return `paused: usage limit reached; it resumes by itself at ${formatUntil(resetsAt + USAGE_LIMIT_RESUME_GRACE_MS, now)} and you get its report then, so don't send the work again`;
}
