import { asRecord } from "./claudeProtocol";

/**
 * What the Claude adapter knows about each chat's prompt cache: when its last
 * turn ended, how long Anthropic keeps that cache, and how big the context
 * is. Kept across app restarts (a restarted Hub resumes the same Claude
 * conversation, whose cache aged meanwhile) and tied to one provider
 * conversation, so a rotation or a fresh session never inherits it.
 */
export type ClaudePromptCacheState = {
  providerSessionId: string;
  lastTurnAt?: number;
  /** How long the cache written by the last turns lives, in ms. */
  cacheTtlMs?: number;
  /** Tokens in the context window after the last turn. */
  contextUsed?: number;
  /**
   * Background compacts in a row that did not land. A real turn or a compact
   * that lands sets it back to zero. Two in a row stop the watcher for this
   * chat (`idleCompactGivenUp`).
   */
  compactFailures?: number;
};

/** The background watcher stops trying a chat after this many failed compacts in a row. */
const IDLE_COMPACT_MAX_FAILURES = 2;

const STORE_KEY = "monocode.claudePromptCache";
/** Newest first; older chats fall off. */
const MAX_ENTRIES = 300;
/**
 * How long one window may hold a background compact before another may take
 * it. A crash is not a final failure: the next look retries after this.
 */
export const IDLE_COMPACT_CLAIM_MS = 10 * 60_000;
/**
 * Pause after writing a claim so a second window's write is visible before
 * this one starts. localStorage has no transaction across windows.
 */
export const IDLE_COMPACT_CLAIM_CONFIRM_MS = 20;

type IdleClaim = { id: string; at: number };

type StoredCache = ClaudePromptCacheState & { at: number; idleClaim?: IdleClaim };

type Store = Record<string, StoredCache>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Store)
      : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const entries = Object.entries(store)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // private mode / quota
  }
}

/** Drop bookkeeping so a turn's record never keeps a compact claim. */
function cacheState(entry: StoredCache): ClaudePromptCacheState {
  const { at: _at, idleClaim: _claim, ...state } = entry;
  return state;
}

export function recallPromptCache(
  threadId: string,
): ClaudePromptCacheState | undefined {
  const entry = readStore()[threadId];
  if (!entry || typeof entry.providerSessionId !== "string") return undefined;
  return cacheState(entry);
}

/** Merge what a turn just reported; a different conversation starts over. */
export function rememberPromptCache(
  threadId: string,
  patch: ClaudePromptCacheState,
): void {
  const store = readStore();
  const previous = store[threadId];
  const base =
    previous?.providerSessionId === patch.providerSessionId
      ? cacheState(previous)
      : undefined;
  store[threadId] = {
    ...base,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
    providerSessionId: patch.providerSessionId,
    at: Date.now(),
  };
  writeStore(store);
}

function heldClaim(claim: unknown, now: number): IdleClaim | undefined {
  if (!claim || typeof claim !== "object") return undefined;
  const id = (claim as { id?: unknown }).id;
  const at = (claim as { at?: unknown }).at;
  if (typeof id !== "string" || !id || typeof at !== "number" || !Number.isFinite(at)) {
    return undefined;
  }
  const age = now - at;
  if (!Number.isFinite(age) || age < -IDLE_COMPACT_CLAIM_MS || age >= IDLE_COMPACT_CLAIM_MS) {
    return undefined;
  }
  return { id, at };
}

/**
 * Take the background compact for this chat. A live claim from another window
 * loses. The caller must confirm after a short wait: two windows can both
 * write, and only the id still stored may proceed.
 */
export function claimIdleCompaction(
  threadId: string,
  claimId: string,
  now: number,
): boolean {
  if (!threadId || !claimId || !Number.isFinite(now)) return false;
  const store = readStore();
  const entry = store[threadId];
  if (!entry || typeof entry.providerSessionId !== "string") return false;
  const held = heldClaim(entry.idleClaim, now);
  if (held && held.id !== claimId) return false;
  entry.idleClaim = { id: claimId, at: now };
  writeStore(store);
  const again = readStore()[threadId];
  return again?.idleClaim?.id === claimId && again.idleClaim.at === now;
}

/** True when this claim is still the one stored, and still inside its window. */
export function confirmIdleCompactionClaim(
  threadId: string,
  claimId: string,
  now: number,
): boolean {
  if (!threadId || !claimId || !Number.isFinite(now)) return false;
  const held = heldClaim(readStore()[threadId]?.idleClaim, now);
  return held?.id === claimId;
}

/** Drop this claim only. Another window's claim is left alone. */
export function releaseIdleCompactionClaim(threadId: string, claimId: string): void {
  if (!threadId || !claimId) return;
  const store = readStore();
  const entry = store[threadId];
  if (!entry?.idleClaim || entry.idleClaim.id !== claimId) return;
  delete entry.idleClaim;
  writeStore(store);
}

/**
 * True once background compacts for this chat have failed twice in a row.
 * A failed compact still rewrites `lastTurnAt` (the CLI reported a result), so
 * without this the chat would be due again after another lifetime, forever.
 * The next real turn sets the count back, and a send after the cache has
 * expired still compacts first.
 */
export function idleCompactGivenUp(state: Pick<ClaudePromptCacheState, "compactFailures">): boolean {
  return (state.compactFailures ?? 0) >= IDLE_COMPACT_MAX_FAILURES;
}

/** Count one background compact that did not land, for this conversation only. */
export function noteIdleCompactFailure(threadId: string, providerSessionId: string): void {
  const state = recallPromptCache(threadId);
  if (!state || state.providerSessionId !== providerSessionId) return;
  rememberPromptCache(threadId, {
    providerSessionId,
    compactFailures: (state.compactFailures ?? 0) + 1,
  });
}

export function forgetPromptCache(threadId: string): void {
  const store = readStore();
  if (!(threadId in store)) return;
  delete store[threadId];
  writeStore(store);
}

/**
 * Cache lifetime from a turn's `usage.cache_creation`: an hour when it wrote
 * 1h entries, five minutes for 5m ones, unknown when it wrote none (then the
 * last known lifetime still holds).
 */
export function promptCacheTtlFromUsage(usage: unknown): number | undefined {
  const creation = asRecord(asRecord(usage)?.cache_creation);
  if (!creation) return undefined;
  const hour = creation.ephemeral_1h_input_tokens;
  const fiveMinutes = creation.ephemeral_5m_input_tokens;
  if (typeof hour === "number" && hour > 0) return 60 * 60_000;
  if (typeof fiveMinutes === "number" && fiveMinutes > 0) return 5 * 60_000;
  return undefined;
}
