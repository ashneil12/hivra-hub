// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution commit ledger (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
// Rust stores the same ranks and never downgrades.

import type { LedgerRow } from "../../attribute-commit";

export const RANK = { person: 0, inferred: 1, confirmed: 2 } as const;

/**
 * Keep the stronger credit. Equal confirmed rows keep the identity already
 * stored when the ids differ. Counts may refresh. A later journal can raise
 * a person's row to inferred.
 */
export function mergeLedger(existing: LedgerRow | null, incoming: LedgerRow): LedgerRow {
  if (!existing) return incoming;
  const kept = RANK[existing.tier];
  const next = RANK[incoming.tier];
  if (next < kept) return existing;
  if (next === kept) {
    if (
      existing.tier === "confirmed" &&
      (existing.chatId !== incoming.chatId || existing.taskId !== incoming.taskId)
    ) {
      return existing;
    }
    return {
      ...existing,
      fileCount: incoming.fileCount,
      lineCount: incoming.lineCount,
    };
  }
  return incoming;
}

/** A failed or timed-out read is not an empty ledger. */
export function keepRows<T>(current: readonly T[], result: { ok: true; rows: readonly T[] } | { ok: false }): T[] {
  if (!result.ok) return [...current];
  return [...result.rows];
}
