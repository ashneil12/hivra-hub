// Today's card names, and the old names a saved dashboard or board may still carry.
/**
 * One "Needs you" card (Critiquito, 22 Oct). The old "Stuck: needs you" and "Needs (up to 5)" / "Decisions (up to 5)"
 * cards were the same list: Today's Needs you section (waiting.ts: stuck rows first, then Ash OS's Needs, proposals,
 * failed builds and stuck workers, five a project with the rest under Later). A number limit means nothing to Ash.
 */
export const NEEDS_YOU_CARD = "Needs you";
/** Card names an older dashboard may still carry, and the card each is now. */
export const LEGACY_TODAY_CARDS: Readonly<Record<string, string>> = {
  "Stuck: needs you": NEEDS_YOU_CARD,
  "Needs (up to 5)": NEEDS_YOU_CARD,
  "Decisions (up to 5)": NEEDS_YOU_CARD,
};
/** A dashboard's cards as they read now: old names mapped to the new card, each card once, order kept. */
export function currentTodayCards(cards: readonly string[]): string[] {
  return [...new Set(cards.map((c) => LEGACY_TODAY_CARDS[c] ?? c))];
}
