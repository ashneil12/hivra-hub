// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution commit ledger (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// Rust stores the same ranks and never downgrades.

import type { LedgerRow } from "../../attribute-commit";

export const RANK = { person: 0, inferred: 1, confirmed: 2 } as const;

/**
 * Keep the stronger credit. Equal confirmed rows keep the identity already
 * stored when the ids differ. An inferred row is replaced only when the new
 * pass matches more distinctive lines. Counts may still refresh.
 */
export function mergeLedger(existing: LedgerRow | null, incoming: LedgerRow): LedgerRow {
  if (!existing) return incoming;
  const kept = RANK[existing.tier];
  const next = RANK[incoming.tier];
  if (next < kept) return existing;
  if (next > kept) return incoming;
  if (
    existing.tier === "confirmed" &&
    (existing.chatId !== incoming.chatId || existing.taskId !== incoming.taskId)
  ) {
    return existing;
  }
  const existingOverlap = existing.overlap ?? 0;
  const incomingOverlap = incoming.overlap ?? 0;
  if (existing.tier === "inferred" && incomingOverlap > existingOverlap) {
    return incoming;
  }
  return {
    ...existing,
    fileCount: incoming.fileCount,
    lineCount: incoming.lineCount,
  };
}

/** A failed or timed-out read is not an empty ledger. */
export function keepRows<T>(current: readonly T[], result: { ok: true; rows: readonly T[] } | { ok: false }): T[] {
  if (!result.ok) return [...current];
  return [...result.rows];
}
