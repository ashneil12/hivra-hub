// WP-135: pick one child. Discarding a loser stops it, then takes its worktree back only when that worktree is clean
// and still at the commit it was made at, and only for a path inside a trusted root. Nothing here merges winners.
import { isEqualOrInside, pathKey } from "../../../shared/lib/paths";
import {
  type CompareRecord,
  type FanOutCleanup,
  type FanOutWorktree,
} from "./fanOut";
import { getCompare, putCompare } from "./fanOutStore";

export type FanOutDecision =
  | { ok: true; record: CompareRecord; changed: boolean }
  | { ok: false; code: string };

export type FanOutCleanupPort = {
  /** Stop the loser's running turn. It is called first, so nothing is still writing when the worktree is looked at. A throw means it may still be running. */
  stop: (childId: string) => Promise<void>;
  /** Trusted worktree roots. A throw or an empty list means try again later. */
  allowedRoots: readonly string[] | (() => Promise<readonly string[]>);
  /**
   * Whether the worktree can be taken back: "remove" when it is clean and still at `madeAt`, "keep" when it holds
   * changes or commits (or `madeAt` is not known), "gone" when git no longer lists it. A throw has not answered.
   */
  inspect: (path: string, madeAt: string | null) => Promise<"remove" | "keep" | "gone">;
  /** Take back one path `inspect` said can go, the usual way and never with force. A throw is not final. */
  remove: (path: string) => Promise<void>;
};

export type CompareStore = {
  get: (id: string) => Promise<CompareRecord | null>;
  /** True only when the record is saved. */
  put: (record: CompareRecord) => Promise<boolean>;
};

const inflight = new Set<string>();

function defaultStore(): CompareStore {
  return {
    get: getCompare,
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

/** A path with ".." or equal to a root, or outside every root, is not inside a trusted root. */
function insideTrustedRoot(path: string, allowedRoots: readonly string[]): boolean {
  if (!path.trim() || hasDotDot(path)) return false;
  return allowedRoots.some((root) => {
    if (typeof root !== "string" || !root.trim() || hasDotDot(root)) return false;
    return isEqualOrInside(path, root) && pathKey(path) !== pathKey(root);
  });
}

/**
 * The path a discard may hand to the removal, and the commit it was made at. A path with ".." or outside every
 * trusted root is blocked. No assigned worktree means there is nothing to remove.
 */
export function fanOutCleanupPlan(
  record: CompareRecord,
  childId: string,
  allowedRoots: readonly string[],
): { kind: "remove"; path: string; head: string | null } | { kind: "none" } | { kind: "outside" } {
  const child = record.children.find((item) => item.id === childId);
  if (!child || child.worktree.kind !== "assigned") return { kind: "none" };
  const path = child.worktree.path;
  return insideTrustedRoot(path, allowedRoots)
    ? { kind: "remove", path, head: child.worktree.head ?? null }
    : { kind: "outside" };
}

async function readRoots(port: Pick<FanOutCleanupPort, "allowedRoots">): Promise<readonly string[]> {
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
    const current = await store.get(compareId);
    if (!current) return { ok: false, code: "missing" };
    const settled = settleFanOutCleanup(current, current.revision, childId, outcome);
    if (!settled.ok) return settled;
    if (!settled.changed || (await store.put(settled.record))) return settled;
  }
  return { ok: false, code: "stale" };
}

/**
 * Discard one loser: stop it if it is running, then take its worktree back when that worktree is clean and still at
 * the commit it was made at. A worktree with changes or commits in it is kept, and the record says so. A loser that
 * could not be stopped, a removal that failed, or git not answering leaves the discard pending, and discarding again
 * picks it up from there.
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
      const current = await store.get(compareId);
      if (!current) return { ok: false, code: "missing" };
      const next = discardFanOutChild(current, current.revision, childId);
      if (!next.ok) return next;
      if (!next.changed || (await store.put(next.record))) reserved = next;
    }
    if (!reserved || !reserved.ok) return { ok: false, code: "stale" };
    const latest = (await store.get(compareId)) ?? reserved.record;
    const state = latest.cleanup?.[childId] ?? (latest.discardedIds.includes(childId) ? "pending" : undefined);
    if (state && state !== "pending") return { ok: true, record: latest, changed: false };
    try {
      await port.stop(childId);
    } catch {
      return { ok: false, code: "cleanup-later" };
    }
    let roots: readonly string[];
    try {
      roots = await readRoots(port);
    } catch {
      return { ok: false, code: "cleanup-later" };
    }
    if (!roots.some((root) => typeof root === "string" && root.trim())) {
      return { ok: false, code: "cleanup-later" };
    }
    const reading = (await store.get(compareId)) ?? latest;
    const plan = fanOutCleanupPlan(reading, childId, roots);
    if (plan.kind === "none") return commit(store, compareId, childId, "none");
    if (plan.kind === "outside") return commit(store, compareId, childId, "blocked");
    let verdict: "remove" | "keep" | "gone";
    try {
      verdict = await port.inspect(plan.path, plan.head);
    } catch {
      return { ok: false, code: "cleanup-later" };
    }
    if (verdict === "gone") return commit(store, compareId, childId, "removed");
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

export async function pickFanOutInStore(
  compareId: string,
  childId: string,
  store: CompareStore = defaultStore(),
): Promise<FanOutDecision> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await store.get(compareId);
    if (!current) return { ok: false, code: "missing" };
    const next = pickFanOutWinner(current, current.revision, childId);
    if (!next.ok || !next.changed) return next;
    if (await store.put(next.record)) return next;
  }
  return { ok: false, code: "stale" };
}

export function fanOutWinnerStays(worktree: FanOutWorktree | null): string {
  if (worktree?.kind === "assigned") return "This worktree stays. Nothing was copied back.";
  return "This chat stays. Nothing was copied back.";
}

/** A worktree a compare made, and the commit it was made at. */
export type MadeWorktree = { path: string; head: string | null };

/**
 * Give back worktrees made for a compare that never started, or never got saved. Each goes through the same checks as
 * a discard: inside a trusted root, and clean and still at the commit it was made at. A path that fails either check,
 * or git not answering, leaves that worktree where it is. Returns how many were given back (a worktree git no longer
 * lists counts); the caller says plainly about the rest.
 */
export async function releaseFanOutWorktrees(
  items: readonly MadeWorktree[],
  port: Pick<FanOutCleanupPort, "allowedRoots" | "inspect" | "remove">,
): Promise<number> {
  let roots: readonly string[];
  try {
    roots = await readRoots(port);
  } catch {
    return 0;
  }
  let given = 0;
  for (const item of items) {
    if (!insideTrustedRoot(item.path, roots)) continue;
    try {
      const verdict = await port.inspect(item.path, item.head);
      if (verdict === "gone") {
        given += 1;
        continue;
      }
      if (verdict !== "remove") continue;
      await port.remove(item.path);
      given += 1;
    } catch {
      // Left for Settings, Worktrees. One worktree that will not go does not stop the next.
    }
  }
  return given;
}
