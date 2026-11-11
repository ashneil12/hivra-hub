// A decision key is a stable name the Inbox files a question under. Some keys belong to the person alone (an irreversible
// step, a fresh-eyes review). Every check on them reads the key folded the same way decisions.rs `fold_key` does: NFKC,
// trimmed, lower-case. Read it raw and "Irreversible/..." or a fullwidth spelling slips past.

/** The form a decision key is checked in: NFKC, trimmed, lower-case. */
export function foldDecisionKey(key: string): string {
  return key.normalize("NFKC").trim().toLowerCase();
}

/** The questions a fresh-eyes review puts to the person (decisions.rs `is_review_key`). */
export function isFreshEyesDecisionKey(key: string): boolean {
  const folded = foldDecisionKey(key);
  return folded.startsWith("fresh-eyes/") || folded.startsWith("fresh-eyes-start/");
}

/** An irreversible step of an orchestration run, parked for the person (decisions.rs `person_only`). */
export function isIrreversibleDecisionKey(key: string): boolean {
  return foldDecisionKey(key).startsWith("irreversible/");
}
