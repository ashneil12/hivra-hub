// Copyright (c) 2026 Kun Chen
// SPDX-License-Identifier: MIT
// Source: https://github.com/kunchenguid/backpass src/memory.js (similarity)
// The licence text is LICENSE beside this file.

/** Sorensen-Dice over word bigrams. One word, or none, is a set of those words. */

function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function similarityFeatures(text: string): Set<string> {
  const words = normalizeForHash(text).split(" ").filter(Boolean);
  if (words.length < 2) return new Set(words);
  const out = new Set<string>();
  for (let i = 0; i < words.length - 1; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

export function featureSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return a.size === b.size ? 1 : 0;
  let shared = 0;
  for (const feature of a) if (b.has(feature)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

export function similarity(a: string, b: string): number {
  return featureSimilarity(similarityFeatures(a), similarityFeatures(b));
}
