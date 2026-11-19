import type { HarnessId } from "./session";
import { findCustomModel } from "./customModels";
import { catalogueWindow, loadCatalogue } from "./modelCatalogue";

/**
 * How big a long-running chat may grow before Claude Code compacts it.
 *
 * Every turn resends the whole context, so a Lead that runs for days and only
 * compacts near its 1M window spends most of the weekly limit re-reading
 * itself. A ceiling well below the window keeps each turn cheap; the model's
 * real window stays the hard limit (Claude Code uses the smaller of the two).
 * Passed to Claude Code as its `autoCompactWindow` setting.
 */

/** Claude Code accepts an auto-compact window from 100K to 1M tokens. */
export const AUTO_COMPACT_MIN_TOKENS = 100_000;
export const AUTO_COMPACT_MAX_TOKENS = 1_000_000;

/**
 * Default ceilings by model family. The priciest models get the lowest one:
 * each resent token costs the most there.
 */
export const MODEL_CONTEXT_CEILINGS: ReadonlyArray<{
  family: string;
  match: RegExp;
  tokens: number;
}> = [
  { family: "Opus", match: /opus|fable|mythos/i, tokens: 350_000 },
  { family: "Sonnet", match: /sonnet/i, tokens: 400_000 },
];

/** Any other Claude model. */
export const DEFAULT_CONTEXT_CEILING = 400_000;

/** "model": the per-model default; "off": Claude Code's own window. */
export type ContextCeilingChoice = "model" | "off" | number;

export const CONTEXT_CEILING_CHOICES: readonly ContextCeilingChoice[] = [
  "model",
  200_000,
  300_000,
  400_000,
  600_000,
  "off",
];

const CEILING_KEY = "monocode.contextCeiling";
const IDLE_COMPACT_KEY = "monocode.idleCompact";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / quota
  }
}

export function loadContextCeilingChoice(): ContextCeilingChoice {
  const raw = read(CEILING_KEY);
  if (raw === "off") return "off";
  const tokens = Number(raw);
  if (raw && Number.isFinite(tokens)) {
    const known = CONTEXT_CEILING_CHOICES.find((choice) => choice === tokens);
    if (known !== undefined) return known;
  }
  return "model";
}

export function saveContextCeilingChoice(choice: ContextCeilingChoice): void {
  write(CEILING_KEY, String(choice));
}

export function modelContextCeiling(model: string): number {
  return (
    MODEL_CONTEXT_CEILINGS.find((entry) => entry.match.test(model))?.tokens ??
    DEFAULT_CONTEXT_CEILING
  );
}

function clampCeiling(tokens: number): number {
  return Math.min(
    AUTO_COMPACT_MAX_TOKENS,
    Math.max(AUTO_COMPACT_MIN_TOKENS, Math.round(tokens)),
  );
}

/**
 * The size a chat compacts at, or undefined to leave it to the provider.
 * Only Claude Code takes a ceiling today.
 * A custom model asks the bundled catalogue first, then these ceilings.
 */
export function contextCeilingFor(
  session: { harness: HarnessId; model: string },
  choice: ContextCeilingChoice = loadContextCeilingChoice(),
  catalogue?: unknown,
): number | undefined {
  if (session.harness !== "claude" || choice === "off") return undefined;
  const tokens = choice === "model" ? tokensForModel(session.model, catalogue) : choice;
  return clampCeiling(tokens);
}

/** WP-104: the catalogue window for a custom route (its provider's row first), otherwise the family ceiling. */
function tokensForModel(model: string, catalogue: unknown): number {
  const custom = findCustomModel(model);
  if (!custom) return modelContextCeiling(model);
  const known = catalogueWindow(custom.modelId, catalogue, custom.provider);
  if (known !== undefined) return known;
  return modelContextCeiling(custom.modelId || model);
}

/**
 * WP-104: a custom route's window comes from the bundled catalogue, which is read the first time one asks. A turn about
 * to start waits here, so its ceiling is the catalogue's and not the family default. Any other model costs nothing.
 */
export async function warmContextCeiling(model: string): Promise<void> {
  if (findCustomModel(model)) await loadCatalogue();
}

/** The room a chat actually has: its window, capped by its ceiling. */
export function effectiveContextWindow(
  window: number | undefined,
  ceiling: number | undefined,
): number | undefined {
  if (!window || window <= 0) return undefined;
  return ceiling ? Math.min(window, ceiling) : window;
}

/**
 * A chat idle past its prompt cache: the next message would rebuild the whole
 * cache at full price, so a big one is compacted first. Below this size the
 * rebuild costs less than the summary. Exactly this size still qualifies.
 */
export const IDLE_COMPACT_MIN_TOKENS = 100_000;

/**
 * How early a big idle chat is compacted, so the summary is what the cache
 * holds. A lifetime shorter than this uses half of itself instead.
 */
export const IDLE_COMPACT_LEAD_MS = 2 * 60_000;

/** The line a chat shows after that background compact. No dash characters. */
export const IDLE_COMPACT_NOTICE =
  "Compacted this idle chat so the next message does not rebuild the whole prompt cache.";

/** Lead before expiry. A lifetime under two minutes is due at half its life. */
export function idleCompactLeadMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 0;
  if (ttlMs < IDLE_COMPACT_LEAD_MS) return ttlMs / 2;
  return IDLE_COMPACT_LEAD_MS;
}

export function loadIdleCompact(): boolean {
  return read(IDLE_COMPACT_KEY) !== "false";
}

export function saveIdleCompact(on: boolean): void {
  write(IDLE_COMPACT_KEY, on ? "true" : "false");
}

export type IdleCompactionDue = {
  idleMs: number;
  ttlMs: number;
  used: number;
  /**
   * True only once the cache has already expired. A send compacts first in
   * that case. Earlier than that, only the idle watcher compacts.
   */
  expired: boolean;
};

/**
 * Whether this chat should be compacted before its prompt cache is rebuilt.
 * Due once it has been idle for longer than `ttl - lead` (two minutes, or
 * half the lifetime when that is shorter). Values from disk are untrusted.
 */
export function idleCompactionDue(
  state: { lastTurnAt?: number; cacheTtlMs?: number; contextUsed?: number },
  now: number,
  enabled: boolean = loadIdleCompact(),
): IdleCompactionDue | null {
  if (!enabled || !Number.isFinite(now)) return null;
  const { lastTurnAt, cacheTtlMs, contextUsed } = state;
  if (
    typeof lastTurnAt !== "number" ||
    typeof cacheTtlMs !== "number" ||
    typeof contextUsed !== "number" ||
    !Number.isFinite(lastTurnAt) ||
    !Number.isFinite(cacheTtlMs) ||
    !Number.isFinite(contextUsed) ||
    cacheTtlMs <= 0
  ) {
    return null;
  }
  if (contextUsed < IDLE_COMPACT_MIN_TOKENS) return null;
  const idleMs = now - lastTurnAt;
  if (!Number.isFinite(idleMs)) return null;
  const lead = idleCompactLeadMs(cacheTtlMs);
  if (idleMs <= cacheTtlMs - lead) return null;
  return {
    idleMs,
    ttlMs: cacheTtlMs,
    used: contextUsed,
    expired: idleMs > cacheTtlMs,
  };
}

/** "5 min", "1 h", "2 h 10 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
