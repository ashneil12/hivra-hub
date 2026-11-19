// WP-135: the compare records this machine keeps. They are saved in the app's own store (the hub documents in its
// database, src-tauri/src/local_hub.rs), so a compare, a pick and a half-finished discard are still there after a
// restart, and they travel with the database in a ship's backup. A value read back is untrusted, and a record that
// claims to merge winners is dropped. A write lands only on the revision just read, so a second window follows the
// first. A save that did not happen says so (false); nothing is held in memory as if it had been kept.
import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import { HARNESSES, type HarnessId } from "./session";
import {
  FAN_OUT_MAX,
  capComparePrompt,
  type CompareRecord,
  type FanOutChild,
  type FanOutCleanup,
  type FanOutTargetRef,
  type FanOutWorktree,
} from "./fanOut";

const PROVIDERS = new Set<string>(HARNESSES);

/** The hub document the compares live in (lowercase, as local_hub.rs requires). */
export const COMPARE_DOC_KEY = "fan-out-compares";

/** Oldest compares go first. Fifty is far more than anyone decides on. */
export const COMPARE_KEEP = 50;

/** How many times a write is made again on top of another window's before it gives up. */
const TRIES = 5;

let disk: LocalHubDisk | null = null;
let records: CompareRecord[] = [];
/** The revision of the document `records` was last read from or written as. */
let knownRev = -1;
let started = false;
let stopWatching: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** The app's database inside Tauri, memory in a plain browser (the preview pages, where `invoke` isn't there). */
function theDisk(): LocalHubDisk {
  if (!disk) {
    const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    disk = inTauri ? tauriLocalHubDisk : memoryDisk();
  }
  return disk;
}

/** Tests: keep the compares in this disk, and forget what was held. Pass null to go back to the app's own store. */
export function useCompareDisk(next: LocalHubDisk | null) {
  stopWatching?.();
  stopWatching = null;
  disk = next;
  records = [];
  knownRev = -1;
  started = false;
  emit();
}

function sameList(a: readonly CompareRecord[], b: readonly CompareRecord[]): boolean {
  return a.length === b.length && a.every((record, index) => record === b[index] || JSON.stringify(record) === JSON.stringify(b[index]));
}

/** Take a document in as the list. Returns true when the list changed. */
function adopt(list: CompareRecord[], rev: number): boolean {
  // A read that finished after a newer write is older than what is held.
  if (rev < knownRev) return false;
  knownRev = rev;
  if (sameList(records, list)) return false;
  records = list;
  return true;
}

/** The document as kept, or null when the store did not answer. Nothing here changes what is held. */
async function readDocument(): Promise<{ list: CompareRecord[]; rev: number } | null> {
  try {
    const doc = await theDisk().readDoc(COMPARE_DOC_KEY);
    return { list: comparesFromUnknown(doc.value), rev: doc.rev };
  } catch {
    return null;
  }
}

async function refresh(): Promise<void> {
  const doc = await readDocument();
  if (doc && adopt(doc.list, doc.rev)) emit();
}

function ensureStarted() {
  if (started) return;
  started = true;
  const current = theDisk();
  void refresh();
  stopWatching = current.watch?.((key, rev) => {
    if (key === COMPARE_DOC_KEY && rev > knownRev) void refresh();
  }) ?? null;
}

/** What is held now. It fills in after the store answers, and again whenever a window writes. */
export function listCompares(): readonly CompareRecord[] {
  ensureStarted();
  return records;
}

/** Read the store now and return what it holds (what was held, when it does not answer). */
export async function loadCompares(): Promise<readonly CompareRecord[]> {
  ensureStarted();
  await refresh();
  return records;
}

/** One compare, read again from the store. When the store does not answer, what is held. */
export async function getCompare(id: string): Promise<CompareRecord | null> {
  ensureStarted();
  const doc = await readDocument();
  if (doc && adopt(doc.list, doc.rev)) emit();
  return records.find((record) => record.id === id) ?? null;
}

export function subscribeCompares(listener: () => void): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function keepNewest(list: readonly CompareRecord[]): CompareRecord[] {
  if (list.length <= COMPARE_KEEP) return [...list];
  const order = list.map((record, index) => ({ record, index }));
  order.sort((a, b) => b.record.createdAt - a.record.createdAt || b.index - a.index);
  const keep = new Set(order.slice(0, COMPARE_KEEP).map((item) => item.record.id));
  return list.filter((record) => keep.has(record.id));
}

/** A write that threw may still have landed (a timeout, say). It did when the store now holds this very record. */
async function alreadySaved(record: CompareRecord): Promise<boolean> {
  const doc = await readDocument();
  if (!doc) return false;
  const held = doc.list.find((item) => item.id === record.id);
  if (held && JSON.stringify(held) === JSON.stringify(record)) {
    if (adopt(doc.list, doc.rev)) emit();
    return true;
  }
  return false;
}

/**
 * First write of an id, or the next revision only. Anything else is refused (false). So is a record this build would
 * not read back, and a store that did not answer: nothing is held in memory instead. The saved prompt is cut at
 * COMPARE_PROMPT_MAX.
 */
export async function putCompare(input: CompareRecord): Promise<boolean> {
  ensureStarted();
  const record = compareFromUnknown(input);
  if (!record) return false;
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const doc = await readDocument();
    if (!doc) return false;
    if (adopt(doc.list, doc.rev)) emit();
    const index = doc.list.findIndex((item) => item.id === record.id);
    let next: CompareRecord[];
    if (index < 0) {
      next = [...doc.list, record];
    } else {
      if (record.revision !== doc.list[index].revision + 1) return false;
      next = doc.list.slice();
      next[index] = record;
    }
    next = keepNewest(next);
    let rev: number | null;
    try {
      rev = await theDisk().write(COMPARE_DOC_KEY, next, doc.rev);
    } catch {
      return alreadySaved(record);
    }
    // null: another window wrote since the read. Read again and apply on top.
    if (rev == null) continue;
    if (adopt(next, rev)) emit();
    return true;
  }
  return false;
}

function headFrom(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-fA-F]{7,64}$/.test(value) ? value : undefined;
}

function worktreeFrom(value: unknown): FanOutWorktree | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { kind?: unknown; path?: unknown; branch?: unknown; reason?: unknown; head?: unknown };
  if (row.kind === "pending" && row.reason === "git-unknown") {
    return { kind: "pending", reason: "git-unknown" };
  }
  if (row.kind === "stay" && (row.reason === "not-a-repo" || row.reason === "no-free-worktree")) {
    return { kind: "stay", reason: row.reason };
  }
  if (row.kind !== "assigned") return null;
  if (typeof row.path !== "string" || typeof row.branch !== "string") return null;
  if (!row.path.trim() || !row.branch.trim()) return null;
  if (/[\0\r\n]/.test(row.path) || /[\0\r\n]/.test(row.branch)) return null;
  if (row.path.replace(/\\/g, "/").split("/").some((part) => part === "..")) return null;
  const head = headFrom(row.head);
  return { kind: "assigned", path: row.path, branch: row.branch.trim(), ...(head ? { head } : {}) };
}

function childFrom(value: unknown): FanOutChild | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { id?: unknown; provider?: unknown; model?: unknown; worktree?: unknown };
  if (typeof row.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(row.id)) return null;
  if (typeof row.provider !== "string" || !PROVIDERS.has(row.provider)) return null;
  if (typeof row.model !== "string") return null;
  const model = row.model.trim();
  if (!model || /[\0\r\n]/.test(model)) return null;
  const worktree = worktreeFrom(row.worktree);
  if (!worktree) return null;
  return { id: row.id, provider: row.provider as HarnessId, model, worktree };
}

/** Drop anything that is not a compare this build understands, including auto-merge. */
export function compareFromUnknown(value: unknown): CompareRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.autoMerge !== false) return null;
  if (typeof row.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(row.id)) return null;
  if (typeof row.revision !== "number" || !Number.isInteger(row.revision) || row.revision < 1) return null;
  if (typeof row.prompt !== "string" || !row.prompt.trim()) return null;
  if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) return null;
  if (!Array.isArray(row.children) || row.children.length < 2 || row.children.length > FAN_OUT_MAX) return null;
  const children: FanOutChild[] = [];
  const seen = new Set<string>();
  for (const item of row.children) {
    const child = childFrom(item);
    if (!child || seen.has(child.id) || child.id === row.id) return null;
    seen.add(child.id);
    children.push(child);
  }
  const discardedIds = Array.isArray(row.discardedIds)
    ? row.discardedIds.filter((id): id is string => typeof id === "string" && seen.has(id))
    : [];
  const winnerId =
    typeof row.winnerId === "string" && seen.has(row.winnerId) && !discardedIds.includes(row.winnerId)
      ? row.winnerId
      : undefined;
  const sourceId =
    typeof row.sourceId === "string" && /^[A-Za-z0-9_-]+$/.test(row.sourceId) ? row.sourceId : undefined;
  const cleanup = cleanupFrom(row.cleanup, discardedIds);
  const notStarted = notStartedFrom(row.notStarted);
  const leftBehind =
    typeof row.leftBehind === "number" && Number.isInteger(row.leftBehind) && row.leftBehind > 0
      ? Math.min(row.leftBehind, FAN_OUT_MAX)
      : undefined;
  return {
    id: row.id,
    revision: row.revision,
    prompt: capComparePrompt(row.prompt),
    createdAt: row.createdAt,
    children,
    discardedIds,
    ...(sourceId ? { sourceId } : {}),
    ...(winnerId ? { winnerId } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(notStarted.length > 0 ? { notStarted } : {}),
    ...(leftBehind ? { leftBehind } : {}),
    autoMerge: false,
  };
}

/** Models that did not start. At most the cap, each a known provider and a plain model name. */
function notStartedFrom(value: unknown): FanOutTargetRef[] {
  if (!Array.isArray(value)) return [];
  const out: FanOutTargetRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { provider?: unknown; model?: unknown };
    if (typeof row.provider !== "string" || !PROVIDERS.has(row.provider)) continue;
    if (typeof row.model !== "string") continue;
    const model = row.model.trim();
    if (!model || /[\0\r\n]/.test(model)) continue;
    out.push({ provider: row.provider as HarnessId, model });
    if (out.length >= FAN_OUT_MAX) break;
  }
  return out;
}

const CLEANUP: readonly FanOutCleanup[] = ["pending", "removed", "kept", "none", "blocked"];

function cleanupFrom(
  value: unknown,
  discardedIds: readonly string[],
): Partial<Record<string, FanOutCleanup>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cleanup: Partial<Record<string, FanOutCleanup>> = {};
  for (const id of discardedIds) {
    const state = (value as Record<string, unknown>)[id];
    if (typeof state === "string" && (CLEANUP as readonly string[]).includes(state)) {
      cleanup[id] = state as FanOutCleanup;
    }
  }
  return Object.keys(cleanup).length > 0 ? cleanup : undefined;
}

export function comparesFromUnknown(value: unknown): CompareRecord[] {
  if (!Array.isArray(value)) return [];
  const out: CompareRecord[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = compareFromUnknown(item);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(record);
  }
  return out;
}
