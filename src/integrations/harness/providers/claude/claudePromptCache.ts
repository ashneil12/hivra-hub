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
};

const STORE_KEY = "monocode.claudePromptCache";
/** Newest first; older chats fall off. */
const MAX_ENTRIES = 300;

type Store = Record<string, ClaudePromptCacheState & { at: number }>;

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

export function recallPromptCache(
  threadId: string,
): ClaudePromptCacheState | undefined {
  const entry = readStore()[threadId];
  if (!entry || typeof entry.providerSessionId !== "string") return undefined;
  const { at: _at, ...state } = entry;
  return state;
}

/** Merge what a turn just reported; a different conversation starts over. */
export function rememberPromptCache(
  threadId: string,
  patch: ClaudePromptCacheState,
): void {
  const store = readStore();
  const previous = store[threadId];
  const base =
    previous?.providerSessionId === patch.providerSessionId ? previous : undefined;
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
