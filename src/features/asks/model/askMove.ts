// The one-time move from the old hub ledger (hub/model/askLedger.ts, localStorage `monocode:hub-ask-ledger`) into Ledger A.
// On the first start after the ledgers were made one, every row there that is still open and that Ledger A holds no match
// for is copied in, marked as moved. The old key is kept as it is for one release (read only, never written, never
// deleted) so nothing is lost if this needs another look; the next release deletes it.
//
// "Matches" means the same message and the same quote, or most of its words (the same 60% word overlap Ledger A's own
// fold uses, asks.ts `covers`). A closed row (handled, parked, dropped) is not copied: it is history, and the old key still
// holds it.
//
// The move is one revision-checked write that also sets `hubMoved`, so two windows starting together copy once and a
// second start copies nothing.
import type { LedgerAsk } from "../../hub/model/askLedger";
import { askId, clipQuote, clipSummary, covers, HUB_MATE, sameAsk, type Ask, type AskCheck, type AskDoc } from "./asks";

const ID_CHARS = /[^A-Za-z0-9._:-]/g;

/** An id the ledger can hold. An odd one from the old key is kept as near as it can be; it only loses its link to the message. */
function safeId(value: string, fallback: string): string {
  return value.replace(ID_CHARS, "_").slice(0, 200) || fallback;
}

function matches(doc: AskDoc, blockId: string, words: string): boolean {
  const same = doc.asks.filter((ask) => ask.blockId === blockId);
  return same.some((ask) => sameAsk(ask.quote, words)) || covers(same, words);
}

function legacyCheck(row: LedgerAsk): AskCheck | undefined {
  const check: AskCheck = {
    ...(row.gap ? { gap: row.gap.slice(0, 300) } : {}),
    ...(row.held?.claim ? { held: { claim: row.held.claim.slice(0, 300), at: Number.isFinite(row.held.at) ? row.held.at : 0 } } : {}),
    ...(row.settledCheck ? { settled: row.settledCheck.slice(0, 200) } : {}),
    ...(row.reopenCheck ? { reopen: row.reopenCheck.slice(0, 200) } : {}),
  };
  return Object.keys(check).length ? check : undefined;
}

export type MoveInput = {
  /** The first mate a chat belongs to, or none. */
  mateOf: (chatId: string) => string | undefined;
  now: number;
};

/** The ledger with the old ledger's open, unmatched rows copied in once. The same document back when it was already done. */
export function withHubMoved(doc: AskDoc, legacy: readonly LedgerAsk[], input: MoveInput): AskDoc {
  if (doc.hubMoved !== undefined) return doc;
  let next = doc.next;
  const asks: Ask[] = [];
  for (const row of legacy) {
    if (row.status !== "open") continue;
    const words = row.words || row.title;
    const quote = clipQuote(words);
    if (!quote) continue;
    const blockId = safeId(row.blockId, "unknown");
    const sessionId = safeId(row.chatId, "unknown");
    // Against what the ledger already holds, never against the rows being copied: two rows the old ledger kept apart stay two.
    if (matches(doc, blockId, words)) continue;
    const at = Number.isFinite(row.at) && row.at >= 0 ? Math.min(row.at, input.now) : input.now;
    const n = next++;
    const check = legacyCheck(row);
    asks.push({
      id: askId(blockId, n),
      n,
      mateId: safeId(input.mateOf(row.chatId) ?? HUB_MATE, HUB_MATE),
      sessionId,
      blockId,
      quote,
      summary: clipSummary(row.title || words),
      kind: "do",
      status: "heard",
      heardBy: "rules",
      createdAt: at,
      updatedAt: at,
      history: [{ at: input.now, status: "heard", by: "app", note: "Moved from the old list" }],
      quiet: true,
      moved: true,
      ...(row.said && row.said > 1 ? { said: Math.min(999, Math.floor(row.said)) } : {}),
      ...(check ? { check } : {}),
    });
  }
  return { ...doc, next, asks: [...doc.asks, ...asks], hubMoved: input.now };
}
