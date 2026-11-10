// WP-203: a structured security review for security-sensitive changes.
//
// The review is the Cloudflare security-audit-skill's shape (a coverage ledger, hunters, a fresh verifier for each
// candidate, findings.json checked by the skill's validators; see reference/ and LICENSE.cloudflare-security-audit).
// This file is Hivra's own code: the builder rule, the diff scope, the run plan, the verification records and the
// merge gate. Hunting itself is done by a builder following reference/SKILL.md; this file records and checks it.

/** Builders that may author or review a change. A name outside this list is refused. */
export const KNOWN_BUILDERS = Object.freeze(["claude", "codex", "grok", "devin", "human"]);

const refuse = (reason) => ({ ok: false, reason });

/**
 * The author and the reviewer of one change must be different, known builders.
 * @param {{ author?: string, reviewer?: string }} roles
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkBuilders({ author, reviewer } = {}) {
  const a = String(author ?? "").trim().toLowerCase();
  const r = String(reviewer ?? "").trim().toLowerCase();
  if (!a) return refuse("The author builder is not recorded for this change, so the review cannot be checked.");
  if (!KNOWN_BUILDERS.includes(a)) return refuse(`The author ${author} is not a known builder.`);
  if (!r) return refuse("The reviewer builder is not recorded for this review.");
  if (!KNOWN_BUILDERS.includes(r)) return refuse(`The reviewer ${reviewer} is not a known builder.`);
  if (a === r) return refuse(`The same builder (${a}) cannot review its own change. Pick a different builder.`);
  return { ok: true, reason: "" };
}
