// WP-99: what the last turn recalled, and why, for the Memory screen to show.
//
// The recall call already builds a full trace for every candidate; this keeps the latest one per
// Mono so the person can open "Why these were recalled" and see the count, not the internals.
// One decision can read several Monos at once; each of them keeps a row that counts only its own memories.
// In this window's memory only, bounded, and never written to disk.

import {
  REJECT_LABEL,
  STOP_LABEL,
  tallyRejections,
  type RecallDecision,
  type RecallRejectReason,
  type RecallStop,
} from "./recallPolicy";

/** The most Monos whose last turn is kept. The least recently recalled is dropped first. */
export const RECALL_TRACES_MAX = 16;
/** Reasons are shown worst first, and at most this many: a long list is not worth reading. */
export const RECALL_TRACE_REASONS_MAX = 4;

export type RecallReason = { label: string; count: number };

/** One turn, as the screen needs it: counts and plain words, no scores. */
export type LastRecall = {
  mateId: string;
  at: number;
  query: string;
  stop?: RecallStop;
  broad: boolean;
  picked: number;
  skipped: number;
  reasons: RecallReason[];
};

const traces = new Map<string, LastRecall>();

/** The row the screen prints, e.g. "picked 3, skipped 12: too few shared words 8, archived 2". */
export function recallSummary(trace: LastRecall): string {
  const reasons = trace.reasons.map((reason) => `${reason.label} ${reason.count}`).join(", ");
  if (trace.stop) {
    const because = STOP_LABEL[trace.stop];
    return reasons ? `Nothing was recalled: ${because}. Skipped: ${reasons}.` : `Nothing was recalled: ${because}.`;
  }
  if (!trace.picked) return `Nothing was recalled. Skipped ${trace.skipped}${reasons ? `: ${reasons}` : ""}.`;
  const head = `picked ${trace.picked}, skipped ${trace.skipped}`;
  return reasons ? `${head}: ${reasons}.` : `${head}.`;
}

/**
 * Stores one turn's trace, one row for each Mono the decision read. The Mono the turn belongs to goes in last, so
 * `latestRecall` reads it; insertion order is redone for each.
 */
export function recordRecall(decision: RecallDecision, at: number): void {
  const [own, ...others] = decision.mateIds;
  for (const mateId of [...others, own]) {
    const candidates = decision.candidates.filter((candidate) => candidate.mateId === mateId);
    const tally = tallyRejections({ candidates });
    const reasons: RecallReason[] = [...tally.entries()]
      .map(([reason, count]) => ({ label: REJECT_LABEL[reason as RecallRejectReason], count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, RECALL_TRACE_REASONS_MAX);
    const skipped = [...tally.values()].reduce((sum, count) => sum + count, 0);
    // A Mono with no memories at all in a decision that read others says so, as it did when it had its own.
    const stop = decision.stop ?? (candidates.length ? undefined : "no_memories");
    const trace: LastRecall = {
      mateId,
      at,
      query: decision.query,
      ...(stop ? { stop } : {}),
      broad: decision.broad,
      picked: candidates.filter((candidate) => candidate.picked).length,
      skipped,
      reasons,
    };
    traces.delete(mateId);
    traces.set(mateId, trace);
  }
  while (traces.size > RECALL_TRACES_MAX) {
    const oldest = traces.keys().next();
    if (oldest.done) break;
    traces.delete(oldest.value);
  }
}

/** The last turn of one Mono, when the screen knows which one it is showing. */
export function lastRecallFor(mateId: string): LastRecall | undefined {
  return traces.get(mateId);
}

/** The most recent turn of any Mono. */
export function latestRecall(): LastRecall | undefined {
  const last = [...traces.values()].pop();
  return last;
}

/** Forgets one Mono's trace, or every trace when no id is given. For tests. */
export function forgetRecall(mateId?: string): void {
  if (mateId === undefined) traces.clear();
  else traces.delete(mateId);
}
