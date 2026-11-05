// Copyright (c) 2026 Kun Chen
// SPDX-License-Identifier: MIT
// Source: https://github.com/kunchenguid/backpass src/tokens.js
// The licence text is LICENSE beside this file.
//
// Rewrite reason: Buffer.byteLength is Node-only. TextEncoder is the same UTF-8 count.

/** Token accounting for the length budget. UTF-8 bytes / 4. A guardrail, not a bill. */

const BYTES_PER_TOKEN = 4;

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_TOKEN);
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export type Budget = {
  capTokens: number;
  current: number;
  projected: number;
  delta: number;
  withinBudget: boolean;
  over: number;
  utilization: number;
};

/**
 * Budget verdict for one file. `over` is how far projected exceeds the cap (0 when within).
 */
export function budgetStatus(
  currentText: string,
  projectedText: string | null | undefined,
  capTokens: number,
  alwaysLoadedExtra: { current?: number; projected?: number } = {},
): Budget {
  const extraCurrent = alwaysLoadedExtra.current ?? 0;
  const current = estimateTokens(currentText) + extraCurrent;
  const projected = estimateTokens(projectedText ?? currentText) + (alwaysLoadedExtra.projected ?? extraCurrent);
  return {
    capTokens,
    current,
    projected,
    delta: projected - current,
    withinBudget: projected <= capTokens,
    over: Math.max(0, projected - capTokens),
    utilization: capTokens > 0 ? projected / capTokens : 0,
  };
}

/** Cap: stay under. Shrink: already over, so the delta must be negative. */
export function budgetGateKind(budget: Budget): "cap" | "shrink" | null {
  if (budget.current <= budget.capTokens && !budget.withinBudget) return "cap";
  if (budget.current > budget.capTokens && budget.delta >= 0) return "shrink";
  return null;
}
