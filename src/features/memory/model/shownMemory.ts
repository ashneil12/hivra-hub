// WP-99: a memory is shown once per conversation. The next turn does not send it again; a
// compacted context or a restarted session has forgotten it, so those send everything again.
// Mnemos keeps the same rule for its cue lines ("never twice in a session"; see docs/hivra/SOURCES.md).
//
// The record lives in this window's memory only, keyed by the conversation's id. That is what makes
// a restart, or a second window, start clean, and it is bounded so a long-lived window cannot grow.

/** The most ids one conversation remembers having shown. */
export const RECALL_SHOWN_MAX = 200;
/** Without a compaction, everything is sent again after this many turns. */
export const RECALL_RESEND_TURNS = 30;
/** The most conversations tracked at once. The least recently recorded is dropped first. */
export const RECALL_SESSIONS_MAX = 64;

type Shown = {
  /** Ids already shown, oldest first. */
  ids: string[];
  /** Turns counted since the last full send. */
  turns: number;
  /** The highest compaction count seen, so a new one is noticed once. */
  compacted: number;
};

const sessions = new Map<string, Shown>();

/** The conversation's record, newest in the map so the least recently used is the one dropped. */
function touch(sessionId: string): Shown {
  const kept = sessions.get(sessionId);
  if (kept) {
    sessions.delete(sessionId);
    sessions.set(sessionId, kept);
    return kept;
  }
  const made: Shown = { ids: [], turns: 0, compacted: 0 };
  sessions.set(sessionId, made);
  while (sessions.size > RECALL_SESSIONS_MAX) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
  return made;
}

/**
 * The ids this conversation has already shown, ready to pass to the policy as `exclude`.
 *
 * Calling this starts a turn: it counts the turn and applies any due full re-send. `compacted` is
 * how many compaction rows the conversation holds; a higher count than last time means the
 * provider replaced its context, so nothing counts as shown and everything may come again.
 */
export function shownIds(sessionId: string, compacted = 0): Set<string> {
  const state = touch(sessionId);
  if (compacted > state.compacted) {
    state.compacted = compacted;
    state.ids = [];
    state.turns = 0;
  }
  state.turns += 1;
  if (state.turns >= RECALL_RESEND_TURNS) {
    // No clean compaction signal for this conversation: a full send every so often is the fallback.
    state.turns = 0;
    state.ids = [];
  }
  return new Set(state.ids);
}

/** Records what this turn showed, so later turns leave it out. Empty ids are ignored. */
export function noteShown(sessionId: string, ids: readonly string[]): void {
  const state = touch(sessionId);
  for (const id of ids) {
    if (typeof id !== "string" || !id) continue;
    if (state.ids.includes(id)) continue;
    state.ids.push(id);
  }
  if (state.ids.length > RECALL_SHOWN_MAX) state.ids = state.ids.slice(-RECALL_SHOWN_MAX);
}

/** Forgets one conversation, or every conversation when no id is given. For tests and sign-out. */
export function forgetShown(sessionId?: string): void {
  if (sessionId === undefined) sessions.clear();
  else sessions.delete(sessionId);
}

/**
 * How many times this conversation's context has been compacted.
 *
 * A compaction is the one row the harness writes for it: a system block reading "Compacted context"
 * (the CLI's own compact records become this through statusTextFromSystem, and the app writes one
 * after a manual compaction). Counting rows rather than watching for a single event means the
 * higher count is still noticed if a window missed the moment it happened.
 */
export function compactionCount(blocks: readonly { role: string; text: string }[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.role === "system" && block.text.startsWith("Compacted context")) count += 1;
  }
  return count;
}
