import { formatTokenCount, formatUsd } from "../../usage/model/history";

/**
 * WP-148: the usage a finished dag run's children had recorded when it closed.
 *
 * A missing read, a zero, or a value that is not a count is left out. It is never stored as zero, and it never
 * fails the close. The same session named twice is one child: the later real record wins, and a later junk record
 * does not wipe it.
 */

const KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const;

type UsageKey = (typeof KEYS)[number];

export type ClosingUsage = Partial<Record<UsageKey, number>>;

function usable(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** One recorded usage object. Anything else, including a row of zeros, is nothing. */
export function normalizeClosingUsage(value: unknown): ClosingUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage: ClosingUsage = {};
  for (const key of KEYS) {
    const number = usable(source[key]);
    if (number != null) usage[key] = number;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function add(total: number, value: number): number {
  const next = total + value;
  if (!Number.isFinite(next)) return Number.MAX_SAFE_INTEGER;
  return Math.min(next, Number.MAX_SAFE_INTEGER);
}

function sumParts(parts: readonly ClosingUsage[]): ClosingUsage | undefined {
  const totals: ClosingUsage = {};
  for (const key of KEYS) {
    let total = 0;
    let any = false;
    for (const part of parts) {
      const value = part[key];
      if (value == null) continue;
      any = true;
      total = add(total, value);
    }
    if (any) totals[key] = total;
  }
  return Object.keys(totals).length ? totals : undefined;
}

/**
 * The usage one child session recorded, across its turns. A repeated block id is one turn (the later real metrics
 * win). An assistant block is not a turn the child was billed for.
 */
export function usageFromSession(session: { blocks?: unknown } | undefined): ClosingUsage | undefined {
  if (!session || !Array.isArray(session.blocks)) return undefined;
  const byTurn = new Map<string, ClosingUsage>();
  let anon = 0;
  for (const block of session.blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const row = block as Record<string, unknown>;
    if (row.role !== "user") continue;
    const usage = normalizeClosingUsage(row.turnMetrics);
    if (!usage) continue;
    const id = typeof row.id === "string" && row.id ? row.id : `anon:${anon++}`;
    byTurn.set(id, usage);
  }
  return sumParts([...byTurn.values()]);
}

/** Sum the children. The same session id is one child. A blank id is not a child. */
export function sumChildUsage(
  children: readonly { sessionId: string; usage: unknown }[],
): ClosingUsage | undefined {
  const bySession = new Map<string, ClosingUsage>();
  for (const child of children) {
    if (typeof child.sessionId !== "string" || !child.sessionId) continue;
    const usage = normalizeClosingUsage(child.usage);
    if (usage) bySession.set(child.sessionId, usage);
  }
  return sumParts([...bySession.values()]);
}

const WORDS: Record<UsageKey, (value: number) => string> = {
  inputTokens: (value) => `${formatTokenCount(value)} in`,
  outputTokens: (value) => `${formatTokenCount(value)} out`,
  cacheReadTokens: (value) => `${formatTokenCount(value)} read from cache`,
  cacheWriteTokens: (value) => `${formatTokenCount(value)} written to cache`,
  costUsd: (value) => formatUsd(value),
};

/** One sentence for the close, or nothing when there is no figure to give. */
export function closingUsageLine(value: unknown): string | undefined {
  const usage = normalizeClosingUsage(value);
  if (!usage) return undefined;
  const parts = KEYS.flatMap((key) => {
    const number = usage[key];
    return number == null ? [] : [WORDS[key](number)];
  });
  return parts.length ? `Children used ${parts.join(", ")}.` : undefined;
}
