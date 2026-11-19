/**
 * WP-176. The one set of dollar helpers the spend limits share. Amounts are kept as whole micro-dollars when they are
 * added, so a total never drifts. Nothing here is a bill: a figure is the CLI's measured cost.
 */

export const MICRO = 1_000_000;
export const MAX_USD = 1_000_000_000;

/** A finite amount of zero or more, in micro-dollars, or undefined when it is not one. */
export function toMicro(usd: unknown): number | undefined {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return undefined;
  const scaled = Math.round(usd * MICRO);
  return Number.isSafeInteger(scaled) ? scaled : undefined;
}

/** Whole dollars without cents, otherwise two decimals: $50, $12.40. */
export function formatUsd(usd: number): string {
  const micros = toMicro(usd);
  if (micros === undefined) return "";
  const cents = Math.round(micros / 10_000);
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * A dollar amount the person typed. Plain digits with an optional cent part only: "50", "12.5", "12.50". Anything else
 * ("$50", "1,000", "0", "1e3", "0x10") is refused, so the caller can say so.
 */
export function parseDollars(text: string): number | "bad" | null {
  const trimmed = text.replace(/\r\n/g, "").trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return "bad";
  return dollarsOrBad(Number(trimmed));
}

/** A positive amount, rounded to the micro-dollar, or "bad". */
export function dollarsOrBad(value: number): number | "bad" {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_USD) return "bad";
  const micros = toMicro(value);
  if (micros === undefined || micros <= 0) return "bad";
  return micros / MICRO;
}
