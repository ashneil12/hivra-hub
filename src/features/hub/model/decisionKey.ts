// A decision key is a stable name the Inbox files a question under. Some keys belong to the person alone (an irreversible
// step, a fresh-eyes review). Every check on them reads the key folded the same way decisions.rs `fold_key` does: NFKC,
// trimmed, lower-case. Read it raw and "Irreversible/..." or a fullwidth spelling slips past.

// Invisible characters (Unicode Cf and the other default-ignorable code points) are dropped before the check.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// str::trim takes U+0085 as white space; String.prototype.trim does not, so it is listed here.
const PADDING = /^[\s\u0085]+|[\s\u0085]+$/g;

/** The form a decision key is checked in: NFKC, invisible characters dropped, trimmed, lower-case. */
export function foldDecisionKey(key: string): string {
  return key.normalize("NFKC").replace(INVISIBLE, "").replace(PADDING, "").toLowerCase();
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

/** A restart decision of a stopped fan-out task (decisions.rs `is_again_key`). Only the person answers it. */
export function isFanoutAgainDecisionKey(key: string): boolean {
  return foldDecisionKey(key).startsWith("fanout-again/");
}

/** A delivery check parked for the person under `gate/<run>` (decisions.rs `is_gate_key`). */
export function isGateDecisionKey(key: string): boolean {
  return foldDecisionKey(key).startsWith("gate/");
}

/** A security review parked for the person (`security-review/<head>`, decisions.rs `is_security_key`). */
export function isSecurityReviewDecisionKey(key: string): boolean {
  return foldDecisionKey(key).startsWith("security-review/");
}

/**
 * A secret (`secret/`). decisions.rs `person_only` does not name it; standing answers already refuse to reuse one.
 * A Page never answers one either, in any spelling.
 */
export function isSecretDecisionKey(key: string): boolean {
  return foldDecisionKey(key).startsWith("secret/");
}

/**
 * The keys a Page never answers. decisions.rs `person_only` is a fresh-eyes review, an irreversible step, a fan-out
 * restart, a delivery check and a security review. A secret is on this list too: standing answers never reuse one,
 * and a Page does not answer it. Every prefix is read on the folded key.
 */
export function isPersonOnlyDecisionKey(key: string): boolean {
  return (
    isFreshEyesDecisionKey(key) ||
    isIrreversibleDecisionKey(key) ||
    isFanoutAgainDecisionKey(key) ||
    isGateDecisionKey(key) ||
    isSecurityReviewDecisionKey(key) ||
    isSecretDecisionKey(key)
  );
}
