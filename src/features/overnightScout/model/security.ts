// WP-165: drafts that touch auth, listeners, merge approval or secrets stay parked.

const RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bauthentication\b/i, reason: "auth" },
  { pattern: /\bauthorisation\b/i, reason: "auth" },
  { pattern: /\bauthorization\b/i, reason: "auth" },
  { pattern: /\bauth\b/i, reason: "auth" },
  { pattern: /\bnetwork listeners?\b/i, reason: "listener" },
  { pattern: /\bsocket listeners?\b/i, reason: "listener" },
  { pattern: /\blisten on\b/i, reason: "listener" },
  { pattern: /\bmerge approval\b/i, reason: "merge" },
  { pattern: /\bsecrets?\b/i, reason: "secret" },
  { pattern: /\bcredentials?\b/i, reason: "secret" },
  { pattern: /\bpassword\b/i, reason: "secret" },
  { pattern: /\bkeychain\b/i, reason: "secret" },
  { pattern: /\bapi keys?\b/i, reason: "secret" },
  { pattern: /\baccess tokens?\b/i, reason: "secret" },
];

/** Why this draft must be parked, or null when it can wait in the queue. */
export function securityParkReason(text: string): string | null {
  if (!text.trim()) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.reason;
  }
  return null;
}
