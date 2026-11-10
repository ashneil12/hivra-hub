import type { HarnessEvent, HarnessSessionInput } from "../../core/types";
import { idleCompactionDue } from "../../../../features/sessions/model/contextCeiling";
import { isTurnRunning } from "../../../../features/sessions/model/inFlight";
import { compactDueIdleClaude, type IdleCompactHold } from "./claude";
import { idleCompactGivenUp, recallPromptCache } from "./claudePromptCache";

/** How often an open app looks for an idle Claude chat that is due. */
const IDLE_COMPACT_LOOK_MS = 30_000;

export type IdleCompactTarget = {
  id: string;
  harness: string;
  busy?: boolean;
  /** Set while the app holds the chat busy for this compact. Never a real turn. */
  idleCompacting?: boolean;
  worktreeRemoved?: boolean;
};

type WatchOptions<T extends IdleCompactTarget> = {
  sessions: () => readonly T[];
  toInput: (session: T) => Omit<HarnessSessionInput, "onEvent">;
  onEvent: (sessionId: string, event: HarnessEvent) => void;
  compact?: (
    input: HarnessSessionInput,
    proceed: () => boolean,
    hold?: IdleCompactHold,
  ) => Promise<boolean>;
  /**
   * Mark the chat busy for the compact, then clear it. Asked right before the
   * compact runs (see `IdleCompactHold`), never for a chat that is turned
   * away first. Return false from the busy call when the chat was already
   * taken, so the compact does not run.
   */
  markBusy?: (sessionId: string, busy: boolean) => boolean;
};

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function isCandidate(session: IdleCompactTarget): boolean {
  return session.harness === "claude" && !session.busy && !session.worktreeRemoved && !!session.id;
}

/**
 * Due, and still inside the lead window. A cache that has already expired is
 * the on-send fallback, not this watcher: resuming every big chat idle for
 * days would compact one of them every look.
 */
function inIdleCompactWindow(session: IdleCompactTarget): boolean {
  const state = recallPromptCache(session.id);
  // A chat whose last two background compacts failed waits for its next turn.
  if (!state || idleCompactGivenUp(state)) return false;
  const due = idleCompactionDue(state, Date.now());
  return due !== null && !due.expired;
}

/**
 * Hold or release the chat's busy flag for one idle compact.
 * The hold is busy plus `idleCompacting`, so Quit, the in-flight list and a
 * restore can tell it from a turn. A newer turn (its generation moved) keeps
 * its own busy flag, so a late release cannot mark that turn idle; the hold
 * flag goes either way. Already busy, or a removed worktree, is not taken.
 */
export function markSessionIdleCompact<T extends IdleCompactTarget>(
  sessions: readonly T[],
  sessionId: string,
  busy: boolean,
  gens: Map<string, number>,
  owners: Map<string, number>,
): { sessions: readonly T[]; ok: boolean } {
  if (busy) {
    const current = sessions.find((item) => item.id === sessionId);
    if (!current || current.busy || current.worktreeRemoved) return { sessions, ok: false };
    const gen = (gens.get(sessionId) ?? 0) + 1;
    gens.set(sessionId, gen);
    owners.set(sessionId, gen);
    return {
      ok: true,
      sessions: sessions.map((item) =>
        item.id === sessionId ? { ...item, busy: true, idleCompacting: true } : item,
      ),
    };
  }
  const owned = owners.get(sessionId);
  owners.delete(sessionId);
  const ours = owned !== undefined && gens.get(sessionId) === owned;
  const current = sessions.find((item) => item.id === sessionId);
  if (!current) return { sessions, ok: ours };
  const clearBusy = ours && !!current.busy;
  if (!clearBusy && !current.idleCompacting) return { sessions, ok: ours };
  return {
    ok: ours,
    sessions: sessions.map((item) =>
      item.id === sessionId
        ? { ...item, ...(clearBusy ? { busy: false } : {}), idleCompacting: undefined }
        : item,
    ),
  };
}

/**
 * One busy change, decided once. The store and the ref can disagree; a second
 * pass must not bump the turn generation again, and a chat that is busy on
 * either side is not taken.
 */
export function commitIdleCompactBusy<T extends IdleCompactTarget>(
  storeSessions: readonly T[],
  refSessions: readonly T[],
  sessionId: string,
  busy: boolean,
  gens: Map<string, number>,
  owners: Map<string, number>,
): { store: readonly T[]; ref: readonly T[]; ok: boolean } {
  const same = storeSessions === refSessions;
  if (busy) {
    const inStore = storeSessions.find((item) => item.id === sessionId);
    const inRef = same ? inStore : refSessions.find((item) => item.id === sessionId);
    if (
      !inStore ||
      !inRef ||
      inStore.busy ||
      inRef.busy ||
      inStore.worktreeRemoved ||
      inRef.worktreeRemoved
    ) {
      return { store: storeSessions, ref: refSessions, ok: false };
    }
    const claimed = markSessionIdleCompact(storeSessions, sessionId, true, gens, owners);
    return {
      ok: true,
      store: claimed.sessions,
      ref: same
        ? claimed.sessions
        : refSessions.map((item) =>
            item.id === sessionId ? { ...item, busy: true, idleCompacting: true } : item,
          ),
    };
  }
  const released = markSessionIdleCompact(storeSessions, sessionId, false, gens, owners);
  if (released.sessions === storeSessions) {
    return { store: storeSessions, ref: refSessions, ok: released.ok };
  }
  return {
    ok: released.ok,
    store: released.sessions,
    ref: same
      ? released.sessions
      : refSessions.map((item) => {
          if (item.id !== sessionId) return item;
          return {
            ...item,
            ...(released.ok && item.busy ? { busy: false } : {}),
            idleCompacting: undefined,
          };
        }),
  };
}

/**
 * Compact the first idle Claude chat that is due, then stop. A chat that
 * loses the claim, or is gone by the time the compact starts, is skipped
 * and the next one is tried. One compact at a time. The chat is held busy
 * only from the moment its compact runs (`hold`), never while it is being
 * checked and turned away.
 */
export async function compactIdleClaudeChats<T extends IdleCompactTarget>(
  options: WatchOptions<T>,
): Promise<boolean> {
  const compact = options.compact ?? compactDueIdleClaude;
  for (const session of options.sessions()) {
    if (!isCandidate(session) || !inIdleCompactWindow(session)) continue;
    // The compact itself re-reads the window, so this only asks whether the chat
    // is still there and has no real turn. The hold is ours, so it is not one.
    const proceed = () => {
      const current = options.sessions().find((item) => item.id === session.id);
      return (
        !!current &&
        current.harness === "claude" &&
        !current.worktreeRemoved &&
        !!current.id &&
        !isTurnRunning(current)
      );
    };
    let held = false;
    const hold: IdleCompactHold | undefined = options.markBusy
      ? {
          begin: () => {
            if (options.markBusy?.(session.id, true) === false) return false;
            held = true;
            return true;
          },
          end: () => {
            if (!held) return;
            held = false;
            options.markBusy?.(session.id, false);
          },
        }
      : undefined;
    let ran = false;
    try {
      ran = await compact(
        {
          ...options.toInput(session),
          onEvent: (event) => {
            if (!options.sessions().some((item) => item.id === session.id)) return;
            options.onEvent(session.id, event);
          },
        },
        proceed,
        hold,
      ).catch(() => false);
    } finally {
      // Whatever the compact did, a chat it left held is let go.
      hold?.end();
    }
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
