// Hivra WP-15: the only status words a person sees (docs/hivra/SPEC.md section 4).
// The word comes from derive_status. Nothing here invents a status from a row's state.

import type { FirstMateStatus } from "../../monos/model/delegations";

const WORDS: Record<FirstMateStatus, string> = {
  working: "working",
  "needs-you": "needs you",
  done: "done",
  failed: "failed",
  paused: "paused",
};

const KNOWN = new Set<string>(Object.keys(WORDS));

/** A status a person may see, or null when the value is missing or not one of the five. */
export function knownStatus(value: unknown): FirstMateStatus | null {
  return typeof value === "string" && KNOWN.has(value)
    ? (value as FirstMateStatus)
    : null;
}

/** The plain word for a status. There is no sixth word. */
export function statusWord(status: FirstMateStatus): string {
  return WORDS[status];
}

export const STATUS_WORDS = ["working", "needs you", "done", "failed", "paused"] as const;
