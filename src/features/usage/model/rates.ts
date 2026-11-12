/**
 * WP-253: public API list prices, used only to estimate what a turn's tokens would cost at API rates.
 *
 * The idea is Up.computer's Usage page (docs/user/usage.md, MIT, github.com/krl-gr/upcomputer): show an
 * API-equivalent estimate and cache savings for every engine, and say plainly that it is not the subscription bill.
 *
 * Rules:
 * - An estimate is never a measured cost. Spend limits (`spendGate`, `taskCeiling`) read `costUsd` only and never
 *   see these figures (a test holds that).
 * - Only models with a source are listed. A model that is not here gets no estimate, never a guess.
 * - Prices are US dollars per million tokens. Cache writes use the 5-minute write price (1.25x input) unless a model
 *   lists its own.
 */

export type ModelRate = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export const RATES_SOURCE =
  "Anthropic API pricing, platform.claude.com/docs/en/about-claude/pricing, read 12 Nov 2026";

function rate(input: number, output: number, cacheRead: number = input * 0.1): ModelRate {
  return { input, output, cacheRead, cacheWrite: input * 1.25 };
}

/** Keyed by the normalised model name (see `rateKey`). */
const RATES: Record<string, ModelRate> = {
  "fable-5-2": rate(8, 40, 0.2),
  "fable-5-1": rate(10, 50),
  "fable-5": rate(10, 50),
  "opus-5-5": rate(4, 20, 0.2),
  "opus-5": rate(5, 25),
  "opus-4-8": rate(5, 25),
  "opus-4-7": rate(5, 25),
  "opus-4-6": rate(5, 25),
  "opus-4-5": rate(5, 25),
  "sonnet-5-5": rate(2, 10, 0.1),
  "sonnet-5": rate(2, 10),
  "sonnet-4-6": rate(3, 15),
  "haiku-5-5": rate(0.1, 0.5),
  "haiku-4-5": rate(1, 5),
};

/**
 * `claude-opus-5-5`, `opus-5.5`, `claude-sonnet-4-6[1m]` and `anthropic/claude-sonnet-4.6` all name a listed model.
 * A trailing date (`-20251101`) and a context tag (`[1m]`) are dropped; dots become dashes.
 */
export function rateKey(model: string): string {
  let key = model.trim().toLowerCase();
  key = key.replace(/\[[^\]]*\]$/, "");
  key = key.slice(key.lastIndexOf("/") + 1);
  key = key.replace(/^claude-/, "");
  key = key.replace(/\./g, "-");
  key = key.replace(/-\d{8}$/, "");
  return key;
}

export function modelRate(model: string | undefined): ModelRate | undefined {
  if (!model) return undefined;
  return RATES[rateKey(model)];
}

export type TurnTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type TurnEstimate = {
  /** What the tokens would cost at the model's API list price. */
  estimatedUsd: number;
  /** What cache reads saved against paying full input price for the same tokens. */
  cacheSavedUsd: number;
};

/** An estimate for one turn, or `undefined` when the model has no listed price. */
export function estimateTurn(model: string | undefined, tokens: TurnTokens): TurnEstimate | undefined {
  const price = modelRate(model);
  if (!price) return undefined;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  const estimatedUsd =
    tokens.inputTokens * perToken(price.input) +
    tokens.outputTokens * perToken(price.output) +
    tokens.cacheReadTokens * perToken(price.cacheRead) +
    tokens.cacheWriteTokens * perToken(price.cacheWrite);
  const cacheSavedUsd = tokens.cacheReadTokens * perToken(price.input - price.cacheRead);
  return { estimatedUsd, cacheSavedUsd: Math.max(0, cacheSavedUsd) };
}
