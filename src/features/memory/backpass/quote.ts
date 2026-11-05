// Copyright (c) 2026 Kun Chen
// SPDX-License-Identifier: MIT
// Source: https://github.com/kunchenguid/backpass src/analyze.js (sanitizeEvidence)
// The licence text is LICENSE beside this file.
//
// A quote must be in the transcript it claims, whitespace folded. Only the literal
// boolean `usedRawTranscript: true` skips that check. The string "true" does not.

export const NEGATIVE_CLASSES = ["harm", "non-compliance", "irrelevant"] as const;

export function foldSpace(text: string): string {
  return String(text).replace(/\s+/g, " ").trim();
}

type EvidenceItem = {
  quote?: unknown;
  instruction?: unknown;
  moment?: unknown;
  effect?: unknown;
  class?: unknown;
  mistake?: unknown;
  proposedInstruction?: unknown;
  recurrenceRisk?: unknown;
  domain?: unknown;
  matchesGap?: unknown;
  coveredBySkill?: unknown;
};

export type CleanGap = {
  mistake: string;
  proposedInstruction: string;
  recurrenceRisk: "high" | "medium" | "low";
  quote: string;
  domain: "project" | "orchestration";
  matchesGap?: string;
  coveredBySkill?: string;
};

export type CleanEvidence = {
  positive: { instruction: string; moment: string; effect: string; quote: string; class?: string }[];
  negative: { instruction: string; moment: string; effect: string; quote: string; class?: string }[];
  gaps: CleanGap[];
  usedRawTranscript: boolean;
  quotesNotInTrace: number;
};

/** Evidence without a verbatim quote is dropped. A quote under 8 characters is dropped. */
export function sanitizeEvidence(
  parsed: { usedRawTranscript?: unknown; positive?: unknown; negative?: unknown; gaps?: unknown } | null,
  memoryFile: { units?: { id: string }[] } | null = null,
  trace: string | null = null,
): CleanEvidence {
  const clean: CleanEvidence = {
    positive: [],
    negative: [],
    gaps: [],
    usedRawTranscript: parsed?.usedRawTranscript === true,
    quotesNotInTrace: 0,
  };
  if (!parsed || typeof parsed !== "object") return clean;

  const validInstructions = memoryFile ? new Set((memoryFile.units ?? []).map((unit) => unit.id)) : null;
  const foldedTrace = typeof trace === "string" && !clean.usedRawTranscript ? foldSpace(trace) : null;
  const hasQuote = (item: EvidenceItem) => {
    if (typeof item?.quote !== "string" || item.quote.trim().length < 8) return false;
    if (foldedTrace === null || foldedTrace.includes(foldSpace(item.quote))) return true;
    clean.quotesNotInTrace += 1;
    return false;
  };

  for (const key of ["positive", "negative"] as const) {
    const list = Array.isArray(parsed[key]) ? (parsed[key] as EvidenceItem[]) : [];
    for (const item of list) {
      if (!hasQuote(item) || typeof item.instruction !== "string" || typeof item.quote !== "string") continue;
      const instruction = item.instruction.trim();
      if (validInstructions && !validInstructions.has(instruction)) continue;
      const entry: CleanEvidence["positive"][number] = {
        instruction,
        moment: String(item.moment ?? "").slice(0, 80),
        effect: String(item.effect ?? "").slice(0, 400),
        quote: item.quote.trim().slice(0, 600),
      };
      if (key === "negative" && NEGATIVE_CLASSES.includes(item.class as (typeof NEGATIVE_CLASSES)[number])) {
        entry.class = item.class as string;
      }
      clean[key].push(entry);
    }
  }

  const gaps = Array.isArray(parsed.gaps) ? (parsed.gaps as EvidenceItem[]) : [];
  for (const item of gaps) {
    if (!hasQuote(item) || typeof item.proposedInstruction !== "string") continue;
    const gap: CleanGap = {
      mistake: String(item.mistake ?? "").slice(0, 400),
      proposedInstruction: item.proposedInstruction.trim().slice(0, 400),
      recurrenceRisk: ["high", "medium", "low"].includes(String(item.recurrenceRisk))
        ? (item.recurrenceRisk as CleanGap["recurrenceRisk"])
        : "medium",
      quote: (item.quote as string).trim().slice(0, 600),
      domain: item.domain === "orchestration" ? "orchestration" : "project",
    };
    if (typeof item.matchesGap === "string" && /^[0-9a-f]{16}$/.test(item.matchesGap.trim())) {
      gap.matchesGap = item.matchesGap.trim();
    }
    if (typeof item.coveredBySkill === "string" && item.coveredBySkill.trim()) {
      gap.coveredBySkill = item.coveredBySkill.trim().slice(0, 120);
    }
    clean.gaps.push(gap);
  }

  return clean;
}
