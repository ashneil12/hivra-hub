// WP-135: pick one child. Discarding a loser asks the janitor before any delete,
// and only for a path inside a trusted root. Nothing here merges winners.
import { isEqualOrInside, pathKey } from "../../../shared/lib/paths";
import {
  type CompareRecord,
  type FanOutCleanup,
  type FanOutWorktree,
} from "./fanOut";
import { listCompares, putCompare } from "./fanOutStore";

export type FanOutDecision =
  | { ok: true; record: CompareRecord; changed: boolean }
  | { ok: false; code: string };

export type FanOutCleanupPort = {
  /** Trusted worktree roots. A throw or an empty list means try again later. */
  allowedRoots: readonly string[] | (() => Promise<readonly string[]>);
  /** Janitor verdict. A throw has not answered. */
  inspect: (path: string) => Promise<"remove" | "keep">;
  /** Delete one path the janitor already said can go. A throw is not final. */
  remove: (path: string) => Promise<void>;
};

type CompareStore = {
  get: (id: string) => CompareRecord | null;
  put: (record: CompareRecord) => boolean;
};

const inflight = new Set<string>();

function defaultStore(): CompareStore {
  return {
    get: (id) => listCompares().find((record) => record.id === id) ?? null,
    put: putCompare,
  };
}

function hasDotDot(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").some((part) => part === "..");
}

/** The winning chat stays where it is. No branch is copied back. */
export function pickFanOutWinner(
  record: CompareRecord,
  expectedRevision: number,
  childId: string,
): FanOutDecision {
  if (record.revision !== expectedRevision) return { ok: false, code: "stale" };
  const child = record.children.find((item) => item.id === childId);
  if (!child) return { ok: false, code: "missing" };
  if (record.discardedIds.includes(childId)) return { ok: false, code: "discarded" };
  if (record.winnerId === childId) return { ok: true, record, changed: false };
  return {
    ok: true,
    changed: true,
    record: { ...record, revision: record.revision + 1, winnerId: childId, autoMerge: false },
  };
}

/** Reserve a discard. The winner cannot be discarded, and a second call does not bump the revision. */
export function discardFanOutChild(
  record: CompareRecord,
  expectedRevision: number,
  childId: string,
): FanOutDecision {
  if (record.revision !== expectedRevision) return { ok: false, code: "stale" };
  if (!record.children.some((item) => item.id === childId)) return { ok: false, code: "missing" };
  if (record.winnerId === childId) return { ok: false, code: "winner" };
  if (record.discardedIds.includes(childId)) return { ok: true, record, changed: false };
  return {
    ok: true,
    changed: true,
    record: {
      ...record,
      revision: record.revision + 1,
      discardedIds: [...record.discardedIds, childId],
      cleanup: { ...record.cleanup, [childId]: "pending" },
      autoMerge: false,
    },
  };
}

/** Record a clean-up result on top of the revision that was read. A finished result stays. */
export function settleFanOutCleanup(
  record: CompareRecord,
  expectedRevision: number,
  childId: string,
  outcome: Exclude<FanOutCleanup, "pending">,
): FanOutDecision {
  if (record.revision !== expectedRevision) return { ok: false, code: "stale" };
  if (!record.discardedIds.includes(childId)) return { ok: false, code: "not-discarded" };
  const current = record.cleanup?.[childId] ?? "pending";
  if (current === outcome || current !== "pending") return { ok: true, record, changed: false };
  return {
    ok: true,
    changed: true,
    record: {
      ...record,
      revision: record.revision + 1,
      cleanup: { ...record.cleanup, [childId]: outcome },
      autoMerge: false,
    },
  };
}

/**
 * The path a discard may hand to the janitor. A path with ".." or outside every
 * trusted root is blocked. No assigned worktree means there is nothing to remove.
 */
export function fanOutCleanupPlan(
  record: CompareRecord,
  childId: string,
  allowedRoots: readonly string[],
): { kind: "remove"; path: string } | { kind: "none" } | { kind: "outside" } {
  const child = record.children.find((item) => item.id === childId);
  if (!child || child.worktree.kind !== "assigned") return { kind: "none" };
  const path = child.worktree.path;
  if (!path.trim() || hasDotDot(path)) return { kind: "outside" };
  const inside = allowedRoots.some((root) => {
    if (typeof root !== "string" || !root.trim() || hasDotDot(root)) return false;
    return isEqualOrInside(path, root) && pathKey(path) !== pathKey(root);
  });
  return inside ? { kind: "remove", path } : { kind: "outside" };
}

async function readRoots(port: FanOutCleanupPort): Promise<readonly string[]> {
  const roots = port.allowedRoots;
  return typeof roots === "function" ? roots() : roots;
}

async function commit(
  store: CompareStore,
  compareId: string,
  childId: string,
  outcome: Exclude<FanOutCleanup, "pending">,
): Promise<FanOutDecision> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = store.get(compareId);
    if (!current) return { ok: false, code: "missing" };
    const settled = settleFanOutCleanup(current, current.revision, childId, outcome);
    if (!settled.ok) return settled;
    if (!settled.changed || store.put(settled.record)) return settled;
  }
  return { ok: false, code: "stale" };
}

/**
 * Discard one loser and, when the janitor says it can go, remove its worktree.
 * A timeout or a janitor that has not answered leaves the discard pending.
 */
export async function discardFanOutLoser(
  compareId: string,
  childId: string,
  port: FanOutCleanupPort,
  store: CompareStore = defaultStore(),
): Promise<FanOutDecision> {
  const key = `${compareId}\0${childId}`;
  if (inflight.has(key)) return { ok: false, code: "in-progress" };
  inflight.add(key);
  try {
    let reserved: FanOutDecision | null = null;
    for (let attempt = 0; attempt < 2 && !reserved; attempt += 1) {
      const current = store.get(compareId);
      if (!current) return { ok: false, code: "missing" };
      const next = discardFanOutChild(current, current.revision, childId);
      if (!next.ok) return next;
      if (!next.changed || store.put(next.record)) reserved = next;
    }
    if (!reserved || !reserved.ok) return { ok: false, code: "stale" };
    const latest = store.get(compareId) ?? reserved.record;
    const state = latest.cleanup?.[childId] ?? (latest.discardedIds.includes(childId) ? "pending" : undefined);
    if (state && state !== "pending") return { ok: true, record: latest, changed: false };
    let roots: readonly string[];
    try {
      roots = await readRoots(port);
    } catch {
      return { ok: false, code: "cleanup-later" };
    }
    if (!roots.some((root) => typeof root === "string" && root.trim())) {
      return { ok: false, code: "cleanup-later" };
    }
    const reading = store.get(compareId) ?? latest;
    const plan = fanOutCleanupPlan(reading, childId, roots);
    if (plan.kind === "none") return commit(store, compareId, childId, "none");
    if (plan.kind === "outside") return commit(store, compareId, childId, "blocked");
    let verdict: "remove" | "keep";
    try {
      verdict = await port.inspect(plan.path);
    } catch {
      return { ok: false, code: "cleanup-later" };
    }
    if (verdict !== "remove") return commit(store, compareId, childId, "kept");
    try {
      await port.remove(plan.path);
    } catch {
      return { ok: false, code: "cleanup-later" };
    }
    return commit(store, compareId, childId, "removed");
  } finally {
    inflight.delete(key);
  }
}

export function pickFanOutInStore(
  compareId: string,
  childId: string,
  store: CompareStore = defaultStore(),
): FanOutDecision {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = store.get(compareId);
    if (!current) return { ok: false, code: "missing" };
    const next = pickFanOutWinner(current, current.revision, childId);
    if (!next.ok || !next.changed) return next;
    if (store.put(next.record)) return next;
  }
  return { ok: false, code: "stale" };
}

export function fanOutWinnerStays(worktree: FanOutWorktree | null): string {
  if (worktree?.kind === "assigned") return "This worktree stays. Nothing was copied back.";
  return "This chat stays. Nothing was copied back.";
}
