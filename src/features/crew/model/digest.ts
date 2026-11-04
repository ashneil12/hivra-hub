// Hivra WP-15: quiet by default.
//
// OpenBot's ping (MIT, server/src/proactive/ping.ts and window.ts) waits out an hour, takes that
// hour once, and does not move the window when there is nothing to say or the send fails. That
// code is Postgres, so this is a translation of those edges: needs you is sent at once and is not
// also in the digest, which is the one place Hivra is stricter.

export type Notice = {
  id: string;
  immediate: boolean;
  title: string;
  at: number;
};

export type DigestState = {
  version: number;
  lastDigestAt: number | null;
  sent: string[];
};

export const EMPTY_DIGEST: DigestState = { version: 0, lastDigestAt: null, sent: [] };

export type DigestPlan = {
  immediate: Notice[];
  digest: Notice[] | null;
  state: DigestState;
};

const HOUR = 60 * 60_000;
const SENT_MAX = 500;

/** A stored digest is untrusted. A bad value falls back to an empty window. */
export function digestStateFrom(value: unknown): DigestState {
  if (!value || typeof value !== "object") return { ...EMPTY_DIGEST, sent: [] };
  const raw = value as { version?: unknown; lastDigestAt?: unknown; sent?: unknown };
  const version = typeof raw.version === "number" && Number.isFinite(raw.version) && raw.version >= 0
    ? Math.floor(raw.version)
    : 0;
  const lastDigestAt = typeof raw.lastDigestAt === "number" && Number.isFinite(raw.lastDigestAt)
    ? raw.lastDigestAt
    : null;
  const sent: string[] = [];
  if (Array.isArray(raw.sent)) {
    for (const item of raw.sent) {
      if (typeof item !== "string" || !item || sent.includes(item)) continue;
      sent.push(item);
    }
  }
  return { version, lastDigestAt, sent: sent.slice(-SENT_MAX) };
}

function noticesOf(notices: readonly Notice[]): Notice[] {
  const byId = new Map<string, Notice>();
  for (const notice of notices) {
    if (!notice || typeof notice.id !== "string" || !notice.id.trim()) continue;
    const previous = byId.get(notice.id);
    if (!previous || notice.at >= previous.at) byId.set(notice.id, notice);
  }
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * What would go out now. Needs you is immediate and never also in the digest.
 * An empty hour, a clock that went backwards, or an hour that is not up yet
 * leaves the window where it was. The first items to collect start the hour
 * without sending.
 */
export function planDigest(
  state: DigestState,
  notices: readonly Notice[],
  now: number,
  hour = HOUR,
): DigestPlan {
  const safe = digestStateFrom(state);
  const list = noticesOf(notices);
  const sent = new Set(safe.sent);
  const immediate = list.filter((notice) => notice.immediate && !sent.has(notice.id));
  const pending = list.filter((notice) => !notice.immediate && !sent.has(notice.id));
  const backwards = safe.lastDigestAt != null && now < safe.lastDigestAt;
  // The first time there is something to collect, the hour starts and nothing is sent.
  // The digest goes out once that hour is up, then not again until the next one.
  const holding = safe.lastDigestAt == null && !backwards && pending.length > 0;
  const due = safe.lastDigestAt != null && !backwards && now >= safe.lastDigestAt + hour;
  const digest = due && pending.length > 0 ? pending : null;
  if (immediate.length === 0 && !digest && !holding) {
    return { immediate, digest: null, state: safe };
  }
  const nextSent = [...safe.sent];
  for (const notice of [...immediate, ...(digest ?? [])]) {
    if (!nextSent.includes(notice.id)) nextSent.push(notice.id);
  }
  const live = new Set(list.map((notice) => notice.id));
  // Dead ids go first, so the cap drops those and keeps a notice that is still on screen.
  const capped = nextSent.length > SENT_MAX
    ? nextSent.filter((id) => !live.has(id)).concat(nextSent.filter((id) => live.has(id))).slice(-SENT_MAX)
    : nextSent;
  return {
    immediate,
    digest,
    state: {
      version: safe.version + 1,
      lastDigestAt: digest || holding ? now : safe.lastDigestAt,
      sent: capped,
    },
  };
}

/** The loser of a race gets null and must not send. */
export function compareAndSwap(
  current: DigestState,
  baseVersion: number,
  next: DigestState,
): DigestState | null {
  if (current.version !== baseVersion) return null;
  return { ...next, version: baseVersion + 1 };
}

export type DigestStore = {
  read(): DigestState;
  /** Writes only when the stored version is still `base`. */
  write(base: number, next: DigestState): boolean | Promise<boolean>;
};

export type DigestShow = {
  show(plan: DigestPlan): void;
  /** True once the show was dropped (a newer render, or the panel went away). */
  cancelled(): boolean;
};

/**
 * Plans, shows, then commits. A cancelled show does not move the window, so the
 * next call can send the same notices. A lost compare-and-swap retries. If every
 * try loses, nothing is sent and the store is left as it was.
 */
export async function showDigest(
  store: DigestStore,
  notices: readonly Notice[],
  now: number,
  hooks: DigestShow,
  hour = HOUR,
  attempts = 3,
): Promise<DigestPlan | null> {
  for (let i = 0; i < attempts; i++) {
    const current = digestStateFrom(store.read());
    const plan = planDigest(current, notices, now, hour);
    if (hooks.cancelled()) return null;
    hooks.show(plan);
    // A render that started while this was planned gets to cancel before the commit.
    await Promise.resolve();
    if (hooks.cancelled()) return null;
    if (plan.state.version === current.version) return plan;
    if (await store.write(current.version, plan.state)) return plan;
  }
  return null;
}

/**
 * Plans, then commits. A lost compare-and-swap retries. If every try loses, nothing is sent
 * and the store is left as it was.
 */
export async function publish(
  store: DigestStore,
  notices: readonly Notice[],
  now: number,
  hour = HOUR,
  attempts = 3,
): Promise<DigestPlan | null> {
  for (let i = 0; i < attempts; i++) {
    const current = digestStateFrom(store.read());
    const plan = planDigest(current, notices, now, hour);
    if (plan.state.version === current.version) return plan;
    if (await store.write(current.version, plan.state)) return plan;
  }
  return null;
}

const LOCK = "hivra.crewDigest";
let tail: Promise<unknown> = Promise.resolve();

/** One digest commit at a time. The browser lock covers two windows; the chain covers one. */
export function withDigestLock<T>(run: () => Promise<T> | T): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) {
    return locks.request(LOCK, () => Promise.resolve(run()));
  }
  const turn = tail.then(() => run());
  tail = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

const KEY = "hivra.crewDigest";

export function readDigestStore(): DigestState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_DIGEST, sent: [] };
    return digestStateFrom(JSON.parse(raw));
  } catch {
    return { ...EMPTY_DIGEST, sent: [] };
  }
}

export function writeDigestStore(base: number, next: DigestState): Promise<boolean> {
  return withDigestLock(() => {
    const current = readDigestStore();
    if (current.version !== base) return false;
    const parsed = digestStateFrom(next);
    const saved: DigestState = {
      version: base + 1,
      lastDigestAt: parsed.lastDigestAt,
      sent: parsed.sent,
    };
    const body = JSON.stringify(saved);
    try {
      localStorage.setItem(KEY, body);
    } catch {
      return false;
    }
    return localStorage.getItem(KEY) === body;
  });
}
