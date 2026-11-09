import type { HarnessEvent, HarnessSessionInput } from "../../core/types";
import { idleCompactionDue } from "../../../../features/sessions/model/contextCeiling";
import { compactDueIdleClaude } from "./claude";
import { recallPromptCache } from "./claudePromptCache";

/** How often an open app looks for an idle Claude chat that is due. */
export const IDLE_COMPACT_LOOK_MS = 30_000;

export type IdleCompactTarget = {
  id: string;
  harness: string;
  busy?: boolean;
  worktreeRemoved?: boolean;
};

type WatchOptions<T extends IdleCompactTarget> = {
  sessions: () => readonly T[];
  toInput: (session: T) => Omit<HarnessSessionInput, "onEvent">;
  onEvent: (sessionId: string, event: HarnessEvent) => void;
  compact?: (input: HarnessSessionInput, proceed: () => boolean) => Promise<boolean>;
};

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function isCandidate(session: IdleCompactTarget): boolean {
  return session.harness === "claude" && !session.busy && !session.worktreeRemoved && !!session.id;
}

function isDue(session: IdleCompactTarget): boolean {
  const state = recallPromptCache(session.id);
  return state !== undefined && idleCompactionDue(state, Date.now()) !== null;
}

/**
 * Compact the first idle Claude chat that is due, then stop. A chat that
 * loses the claim, or is gone by the time the compact starts, is skipped
 * and the next one is tried. One compact at a time.
 */
export async function compactIdleClaudeChats<T extends IdleCompactTarget>(
  options: WatchOptions<T>,
): Promise<boolean> {
  const compact = options.compact ?? compactDueIdleClaude;
  for (const session of options.sessions()) {
    if (!isCandidate(session) || !isDue(session)) continue;
    const proceed = () => {
      const current = options.sessions().find((item) => item.id === session.id);
      return !!current && isCandidate(current) && isDue(current);
    };
    const ran = await compact(
      {
        ...options.toInput(session),
        onEvent: (event) => {
          if (!options.sessions().some((item) => item.id === session.id)) return;
          options.onEvent(session.id, event);
        },
      },
      proceed,
    ).catch(() => false);
    if (ran) return true;
  }
  return false;
}

/**
 * Look now, and again on an interval, for an idle Claude chat to compact.
 * A hidden window waits until it is visible. A look that is still running
 * is not started again.
 */
export function watchIdleClaudeCompaction<T extends IdleCompactTarget>(
  options: WatchOptions<T>,
): () => void {
  let stopped = false;
  let looking = false;
  const look = () => {
    if (stopped || looking || !visible()) return;
    looking = true;
    void compactIdleClaudeChats(options)
      .catch(() => false)
      .finally(() => {
        looking = false;
      });
  };
  look();
  const timer = setInterval(look, IDLE_COMPACT_LOOK_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") look();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    stopped = true;
    clearInterval(timer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}
