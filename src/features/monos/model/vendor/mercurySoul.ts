// Copyright © 2026 Cosmic Stack
// SPDX-License-Identifier: MIT
// Source: https://github.com/cosmicstack-labs/mercury-agent src/soul/identity.ts
// The licence text is LICENSE beside this file.
//
// needsMigration and normalizeSoulText, copied from Identity. The original looks
// the legacy text up by filename; Hivra passes that list in. Rewrite reason:
// Mercury's stored legacy souls are Cosmic Stack text, which this package does not include.

/** Line endings and trailing whitespace don't make a file "edited". */
export function normalizeSoulText(text: string): string {
  return text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();
}

/**
 * Only an untouched legacy template is migrated. The old check matched any
 * mention of a product name and silently overwrote files the owner had
 * edited; an edited file is theirs.
 */
export function needsMigration(content: string, legacy: readonly string[]): boolean {
  if (legacy.length === 0) return false;
  const normalized = normalizeSoulText(content);
  return legacy.some((template) => normalizeSoulText(template) === normalized);
}
