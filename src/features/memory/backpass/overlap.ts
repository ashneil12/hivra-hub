// Copyright (c) 2026 Kun Chen
// SPDX-License-Identifier: MIT
// Source: https://github.com/kunchenguid/backpass src/overlap.js
// The licence text is LICENSE beside this file.
//
// Rewrite reason: the skill-body unit parser stays in backpass. Hivra only reports
// whether a named instruction overlaps a skill's description or body, and it never deletes.

import { featureSimilarity, similarityFeatures } from "./similarity";

/** Same bar as gap coverage: enough to call the texts the same unit. */
export const CROSS_SURFACE_OVERLAP_THRESHOLD = 0.6;

export type OverlapHit = {
  memory: string;
  skill: string;
  surface: "description" | "body";
  score: number;
};

function variants(text: string): string[] {
  const original = text.trim();
  if (!original) return [];
  const bare = original.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
  return bare === original ? [original] : [original, bare];
}

function bestScore(left: string, right: string): number {
  let best = 0;
  for (const a of variants(left)) {
    for (const b of variants(right)) {
      best = Math.max(best, featureSimilarity(similarityFeatures(a), similarityFeatures(b)));
    }
  }
  return best;
}

/**
 * Report overlap between instruction lines and skill text.
 * The inputs are not changed. Nothing is removed.
 */
export function overlapReport(
  memoryLines: readonly string[],
  skills: readonly { name: string; description?: string; body?: string }[],
): OverlapHit[] {
  const hits: OverlapHit[] = [];
  for (const line of memoryLines) {
    if (!line.trim()) continue;
    for (const skill of skills) {
      const description = skill.description?.trim() ?? "";
      const body = skill.body?.trim() ?? "";
      if (description) {
        const score = bestScore(line, description);
        if (score >= CROSS_SURFACE_OVERLAP_THRESHOLD) {
          hits.push({ memory: line, skill: skill.name, surface: "description", score });
        }
      }
      if (body) {
        const score = bestScore(line, body);
        if (score >= CROSS_SURFACE_OVERLAP_THRESHOLD) {
          hits.push({ memory: line, skill: skill.name, surface: "body", score });
        }
      }
    }
  }
  return hits;
}
