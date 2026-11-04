// Hivra WP-60: the desktop's read and write of a remote project's first mate.
// Records stay on the host. This only remembers how far this desktop has read,
// so a reconnect shows what happened once.

import {
  INITIATORS,
  type CatchUpEntry,
  type CatchUpPage,
  type HostDelegation,
  type Initiator,
} from "./types";

export type HostRequester = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type CursorStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Write only when the stored value is still `expected`. Absent, the store compares and then writes. */
  compareAndSwap?(key: string, expected: string | null, next: string): boolean;
};

const KINDS: readonly CatchUpEntry["kind"][] = ["started", "finished", "failed", "cancelled"];

export function catchUpKey(environmentId: string, projectId: string): string {
  return `monocode:remote-firstmate:${environmentId}:${projectId}`;
}

type Cursor = { after: number; seen: number[] };

function readCursor(raw: string | null): Cursor {
  if (!raw) return { after: 0, seen: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { after: 0, seen: [] };
    const value = parsed as { after?: unknown; seen?: unknown };
    const after =
      typeof value.after === "number" && Number.isSafeInteger(value.after) && value.after >= 0 ? value.after : 0;
    const seen = Array.isArray(value.seen)
      ? value.seen.filter((entry): entry is number => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)
      : [];
    return { after, seen };
  } catch {
    return { after: 0, seen: [] };
  }
}

function swap(storage: CursorStore, key: string, expected: string | null, next: string): boolean {
  if (storage.compareAndSwap) return storage.compareAndSwap(key, expected, next);
  if (storage.getItem(key) !== expected) return false;
  storage.setItem(key, next);
  return storage.getItem(key) === next;
}

function isEntry(value: unknown): value is CatchUpEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.seq === "number" &&
    Number.isSafeInteger(entry.seq) &&
    entry.seq >= 0 &&
    typeof entry.projectId === "string" &&
    typeof entry.delegationId === "string" &&
    typeof entry.ownerSession === "string" &&
    KINDS.includes(entry.kind as CatchUpEntry["kind"]) &&
    INITIATORS.includes(entry.startedBy as Initiator) &&
    typeof entry.text === "string" &&
    typeof entry.at === "number"
  );
}

/**
 * Apply one catch-up page. Entries this desktop already applied are dropped,
 * including when the same page arrives twice or the stored cursor is corrupt.
 * A store that cannot be written does not count the page as applied.
 */
export function acceptCatchUp(
  storage: CursorStore,
  environmentId: string,
  projectId: string,
  page: { entries?: unknown },
): CatchUpEntry[] {
  const key = catchUpKey(environmentId, projectId);
  let incoming = Array.isArray(page.entries) ? page.entries.filter(isEntry) : [];
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = storage.getItem(key);
      const current = readCursor(raw);
      const seen = new Set(current.seen);
      const fresh: CatchUpEntry[] = [];
      for (const entry of incoming) {
        if (seen.has(entry.seq)) continue;
        seen.add(entry.seq);
        fresh.push(entry);
      }
      if (!fresh.length) return [];
      const after = Math.max(current.after, ...fresh.map((entry) => entry.seq));
      const next = JSON.stringify({ after, seen: [...seen] });
      if (!swap(storage, key, raw, next)) {
        incoming = fresh;
        continue;
      }
      const checked = readCursor(storage.getItem(key));
      const lost = fresh.filter((entry) => !checked.seen.includes(entry.seq) || checked.after < entry.seq);
      if (!lost.length) return fresh.filter((entry) => checked.seen.includes(entry.seq));
      incoming = lost;
    }
  } catch {
    return [];
  }
  return [];
}

/** Pull what the host did after this desktop's cursor. A miss leaves the cursor where it was. */
export type CatchUpOptions = {
  /** Show the page in the chat. False, or a throw, leaves the cursor where it was. */
  deliver?: (entries: CatchUpEntry[]) => Promise<boolean> | boolean;
  /** False once the reader is gone. A late page is neither shown nor stored. */
  alive?: () => boolean;
};

export async function catchUpRemoteProject(
  request: HostRequester,
  environmentId: string,
  projectId: string,
  storage?: CursorStore,
  options?: CatchUpOptions,
): Promise<CatchUpEntry[]> {
  // Resolved in here so a missing or locked store rejects this call, not the poll that started it.
  const store = storage ?? globalThis.localStorage;
  if (!environmentId.trim() || !projectId.trim() || environmentId.includes("\0") || projectId.includes("\0")) return [];
  if (options?.alive && !options.alive()) return [];
  const key = catchUpKey(environmentId, projectId);
  let page: unknown;
  try {
    const cursor = readCursor(store.getItem(key));
    page = await request("firstmate.catchUp", { projectId, after: cursor.after });
  } catch {
    return [];
  }
  if (options?.alive && !options.alive()) return [];
  if (!page || typeof page !== "object" || Array.isArray(page)) return [];
  const entries = Array.isArray((page as CatchUpPage).entries) ? (page as CatchUpPage).entries.filter(isEntry) : [];
  if (!options?.deliver) return acceptCatchUp(store, environmentId, projectId, { entries });
  const seen = new Set(readCursor(store.getItem(key)).seen);
  const fresh = entries.filter((entry) => !seen.has(entry.seq));
  // A start is recorded. Only a result is shown, and only before the cursor moves.
  const reports = fresh.filter((entry) => entry.kind !== "started");
  if (reports.length) {
    try {
      if (!(await options.deliver(reports))) return [];
    } catch {
      return [];
    }
    if (options.alive && !options.alive()) return [];
  }
  return acceptCatchUp(store, environmentId, projectId, { entries: fresh });
}

/** Start a brief on the host, or read the worker this launch key already started. */
export async function briefRemoteProject(
  request: HostRequester,
  params: Record<string, unknown>,
): Promise<{ delegation: HostDelegation; created: boolean }> {
  const result = await request("firstmate.brief", params);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Host returned no brief");
  const value = result as { delegation?: HostDelegation; created?: boolean };
  if (!value.delegation || typeof value.delegation.id !== "string" || typeof value.created !== "boolean") {
    throw new Error("Host returned no brief");
  }
  return { delegation: value.delegation, created: value.created };
}
