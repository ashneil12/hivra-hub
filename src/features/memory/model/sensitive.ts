// Sensitive topics in memory: health, faith, politics, money, and who someone is or loves. Remembered by default,
// because a first mate that forgets "I'm vegetarian for religious reasons" or "I have a bad back" is a worse one
// (Ash, 13 Nov 2026). One switch in Settings > Memory turns it off, and the Memory screen marks what is kept on these
// topics and removes it all in one go. Read by rules, with no model: a missed word errs towards remembering, and the
// person can always remove a single fact.
// "Remember that ..." in the person's own words is always kept, switch or no switch: they asked.

import { useSyncExternalStore } from "react";
import { withForgotten, bump, type MemoryDoc, type MemoryItem } from "./doc";

export const SENSITIVE_KEY = "monocode.memorySensitive";
export const SENSITIVE_CHANGE_EVENT = "monocode:memorysensitivechange";

export type SensitiveTopic = "health" | "faith" | "politics" | "money" | "identity";

export const SENSITIVE_LABEL: Record<SensitiveTopic, string> = {
  health: "Health",
  faith: "Faith",
  politics: "Politics",
  money: "Money",
  identity: "Identity",
};

const TOPICS: ReadonlyArray<[SensitiveTopic, RegExp]> = [
  [
    "health",
    /\b(diagnos\w*|therap(y|ist)|medication|prescri\w+|antidepress\w*|depress(ion|ed)|anxiety|adhd|autis\w+|bipolar|cancer|diabet\w+|chronic|disabilit\w+|disabled|pregnan\w+|miscarr\w+|surgery|illness|mental health|psychiatr\w+|rehab|sober|sobriety|addict\w+|hiv|migraine\w*|allerg\w+|asthma|insomnia|eating disorder)\b/i,
  ],
  ["faith", /\b(religio\w+|christian\w*|catholic\w*|muslim\w*|islam\w*|jewish|judaism|hindu\w*|buddhis\w+|sikh\w*|atheis\w+|agnostic|church|mosque|synagogue|temple|pray(s|er|ers|ing)?|ramadan|kosher|halal|baptis\w+)\b/i],
  ["politics", /\b(vot(e|es|ed|ing) for|democrat\w*|republican\w*|conservative party|labour party|liberal party|left[- ]wing|right[- ]wing|political (view|belief|party)\w*|trade union|union member|protest(ed|ing)?|activis\w+)\b/i],
  ["money", /\b(salary|income|net worth|debt\w*|mortgage|bankrupt\w*|credit score|savings of|earns?\b.{0,20}\b(a|per) (year|month)|owes?\b|loan\w*|overdraft|tax return)\b/i],
  ["identity", /\b(gay|lesbian|bisexual|queer|transgender|trans (man|woman)|non[- ]binary|sexual orientation|sexuality|came out|ethnicit\w+|race is|immigration status|visa status|asylum|undocumented|criminal record|convict\w+|arrested)\b/i],
];

/** The sensitive topic a remembered line is on, or none. */
export function sensitiveTopic(text: string): SensitiveTopic | undefined {
  for (const [topic, pattern] of TOPICS) if (pattern.test(text)) return topic;
  return undefined;
}

/** The kept facts on a sensitive topic. Skills are procedures, not facts about the person. */
export function sensitiveItems(doc: Pick<MemoryDoc, "items">): MemoryItem[] {
  return doc.items.filter((item) => item.action === "add" && !!sensitiveTopic(item.text));
}

/**
 * Removes every kept fact on a sensitive topic, for good: each goes off the list and onto the "don't learn this
 * again" list, the way a single Delete does. The let-go list loses them too.
 */
export function withoutSensitive(doc: MemoryDoc): MemoryDoc {
  const gone = sensitiveItems(doc);
  const archived = (doc.archived ?? []).filter((item) => item.action === "add" && !!sensitiveTopic(item.text));
  if (!gone.length && !archived.length) return doc;
  const ids = new Set([...gone, ...archived].map((item) => item.id));
  let next: MemoryDoc = {
    ...doc,
    items: doc.items.filter((item) => !ids.has(item.id)),
    ...(doc.archived ? { archived: doc.archived.filter((item) => !ids.has(item.id)) } : {}),
  };
  for (const item of [...gone, ...archived]) next = withForgotten(next, item.mateId, item.text);
  return bump(next);
}

/** True unless the person switched it off. Anything unreadable is on. */
export function readSensitive(value: unknown): boolean {
  return !(value === "off" || value === '"off"' || value === false || value === "false");
}

export function loadSensitive(): boolean {
  try {
    return readSensitive(localStorage.getItem(SENSITIVE_KEY));
  } catch {
    return true;
  }
}

export function saveSensitive(on: boolean): void {
  try {
    localStorage.setItem(SENSITIVE_KEY, on ? "on" : "off");
  } catch {
    // Nothing was written, so the screen keeps showing what is saved.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SENSITIVE_CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === SENSITIVE_KEY || event.key === null) onChange();
  };
  window.addEventListener(SENSITIVE_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SENSITIVE_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSensitive(): boolean {
  return useSyncExternalStore(subscribe, loadSensitive, () => true);
}
