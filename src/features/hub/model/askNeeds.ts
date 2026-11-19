// r67 (Critiquito on r66): the red rule ("Needs you" for what only Ash can do) was only applied to asks made after it
// landed. Ash OS's existing asks (sign in for Grok, turn on remote control, log into X, two decisions) came through as
// plain grey rows while Hub, Hivra and EXO showed a badge of 5 for them. Classified here on read, so every open ask the
// badge counts reads red, with the reason from the same short list the new asks use (chatQuestions.ts NEEDS_REASONS).
import { keyAsk, provideNeeded, type NeedsReason } from "./chatQuestions";
import type { Need } from "./types";

const SIGN_IN = /\b(?:sign[\s-]?in|log[\s-]?in|login|log\s+(?:me\s+)?into|sign\s+(?:me\s+)?into)\b/i;
const CODE = /\b(?:2fa|two[\s-]factor|verification\s+code|one[\s-]time\s+code|otp)\b/i;
const PAY = /\b(?:pay|payment|billing|card|subscribe|purchase|buy)\b/i;
const CHOICE = /^(?:which|what|should|do\s+(?:you|we)\s+want|would\s+you\s+(?:rather|prefer))\b|\bor\b.*\?$|\b(?:choose|pick|option)\b/i;
/** "Can you … yourself" or "an account setting I can't change": an errand only Ash can run. */
const ERRAND = /\byourself\b|\bonly\s+(?:you|ash)\b|\bi\s+can(?:no|')t\s+(?:change|do|reach|access)\b/i;

/** Whether a Need is one of Ash OS's asks (a question), as opposed to a job, a Looks-right row or a plain note. */
export function isAskNeed(need: Pick<Need, "actionTarget">): boolean {
  return !!need.actionTarget?.startsWith("question:");
}

/** Why an existing ask needs Ash, from its own words: the same reasons a new ask names. */
export function askReason(need: Pick<Need, "title" | "why">): NeedsReason {
  const title = need.title ?? "";
  const provide = provideNeeded(title);
  if (provide) return keyAsk(provide) ? "Needs a key from you" : "provide something";
  if (SIGN_IN.test(title)) return "sign in";
  if (CODE.test(title)) return "enter a code";
  if (PAY.test(title)) return "pay";
  if (ERRAND.test(title)) return "provide something";
  if (CHOICE.test(title.trim()) || /^my\s+suggestion\s*:/i.test(need.why ?? "")) return "pick an option";
  return "review";
}

/**
 * Whether a row reads red: an open ask that counts toward the project's badge (shown, not under Later, not ticked off).
 * The rail reads the one Needs you list, so a red row and that number stay the same thing.
 */
export function askNeedsAsh(need: Pick<Need, "actionTarget" | "state">, counted: boolean): boolean {
  return counted && isAskNeed(need) && need.state !== "done";
}
