// Copyright © 2026 Cosmic Stack
// SPDX-License-Identifier: MIT
// Source: https://github.com/cosmicstack-labs/mercury-agent src/memory/beliefs.ts
// The licence text is LICENSE.mercury beside this file.
//
// ftsMatch and confidence, copied. Rewrite reason: BeliefStore needs Mercury's
// sqlite driver, which this package does not include.

export type BeliefTimescale = "stable" | "situational" | "episodic";
export type BeliefKind =
  | "fact"
  | "relationship"
  | "preference"
  | "goal"
  | "project"
  | "trait"
  | "situation"
  | "episode";

/** The fields confidence and halfLifeDays read. Mercury's Belief has more. */
export type Belief = {
  support: number;
  against: number;
  ownerStated: boolean;
  status: string;
  lastSupportedAt: number;
  timescale: BeliefTimescale;
  kind: BeliefKind;
};

const HALF_LIFE_DAYS: Record<BeliefTimescale, number> = { stable: 60, situational: 0.5, episodic: 30 };
/** Stable beliefs fade at different speeds: who the owner is barely changes; how they want to work does. */
const KIND_HALF_LIFE_DAYS: Partial<Record<BeliefKind, number>> = { fact: 365, relationship: 365, preference: 120, goal: 90, project: 90, trait: 60 };
function halfLifeDays(b: Belief): number {
  return b.timescale === "stable" ? (KIND_HALF_LIFE_DAYS[b.kind] ?? HALF_LIFE_DAYS.stable) : HALF_LIFE_DAYS[b.timescale];
}
const DAY = 86_400_000;
export const RETIRE_BELOW = 0.35;

/** Words that match almost every belief and only add noise to an OR query. */
const STOPWORDS = new Set(["the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "were", "have", "has", "had", "can", "could", "would", "should", "will", "what", "when", "where", "which", "who", "how", "why", "not", "but", "all", "any", "some", "just", "like", "about", "from", "into", "than", "then", "them", "they", "their", "there", "here", "also", "very", "much", "more", "most", "does", "did", "doing", "done", "please", "thanks", "okay", "yeah", "hey", "want", "need", "make", "get", "got", "let", "use", "using", "one", "two", "now", "out", "its", "our", "mine", "yours", "me", "my", "we", "us", "it", "is", "be", "do", "to", "of", "in", "on", "at", "by", "or", "an", "as", "if", "so", "no", "up", "am"]);

/** An FTS5 OR-query from free text: lower-cased, punctuation out, stopwords out, deduped, capped. */
export function ftsMatch(text: string, opts: { minLength?: number; max?: number } = {}): string | null {
  const minLength = opts.minLength ?? 3;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
    if (raw.length < minLength || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= (opts.max ?? 24)) break;
  }
  return terms.length === 0 ? null : terms.map((t) => `"${t}"`).join(" OR ");
}

/** Beta-mean of the evidence, decayed by time since the last support. Confirmed/owner-stated beliefs don't decay. */
export function confidence(b: Belief, now = Date.now()): number {
  const mean = (b.support + 1) / (b.support + b.against + 2);
  if (b.ownerStated || b.status === "confirmed") return Math.min(0.98, Math.max(mean, 0.85));
  const ageDays = Math.max(0, now - b.lastSupportedAt) / DAY;
  const decay = Math.pow(0.5, ageDays / halfLifeDays(b));
  return mean * decay;
}
