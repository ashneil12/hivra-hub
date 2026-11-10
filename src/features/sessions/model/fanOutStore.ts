// WP-135: the compare records this machine keeps. They are saved in the webview's own storage so a compare, a pick
// and a half-finished discard are still there after a restart. A value read back is untrusted, and a record that
// claims to merge winners is dropped. A failed read or write is not final: the record stays in memory and the next
// write saves it, and two windows follow each other by revision.
import { HARNESSES, type HarnessId } from "./session";
import {
  FAN_OUT_MAX,
  type CompareRecord,
  type FanOutChild,
  type FanOutCleanup,
  type FanOutTargetRef,
  type FanOutWorktree,
} from "./fanOut";

const PROVIDERS = new Set<string>(HARNESSES);

export const COMPARE_STORAGE_KEY = "monocode:fan-out-compares";

/** Oldest compares go first. Fifty is far more than anyone decides on. */
export const COMPARE_KEEP = 50;

let records: CompareRecord[] = [];
let loaded = false;
let listening = false;
/** The text last read from or written to storage, so an unchanged document is not read again. */
let lastRaw: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** The saved text, null when nothing is saved, undefined when storage cannot be read at all. */
function readRaw(): string | null | undefined {
  try {
    return localStorage.getItem(COMPARE_STORAGE_KEY);
  } catch {
    return undefined;
  }
}

function writeRaw(raw: string): boolean {
  try {
    localStorage.setItem(COMPARE_STORAGE_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

/** Per id the higher revision wins; at the same revision what storage holds wins. */
function merge(memory: readonly CompareRecord[], stored: readonly CompareRecord[]): CompareRecord[] {
  const byId = new Map<string, CompareRecord>();
  for (const record of memory) byId.set(record.id, record);
  for (const record of stored) {
    const held = byId.get(record.id);
    if (!held || record.revision >= held.revision) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function keepNewest(list: readonly CompareRecord[]): CompareRecord[] {
  if (list.length <= COMPARE_KEEP) return [...list];
  const order = list.map((record, index) => ({ record, index }));
  order.sort((a, b) => b.record.createdAt - a.record.createdAt || b.index - a.index);
  const keep = new Set(order.slice(0, COMPARE_KEEP).map((item) => item.record.id));
  return list.filter((record) => keep.has(record.id));
}

function parseStored(raw: string | null): CompareRecord[] | null {
  if (raw === null) return [];
  try {
    return comparesFromUnknown(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Take in what another window or an earlier run saved. Returns true when the list changed. */
function refresh(): boolean {
  const raw = readRaw();
  if (raw === undefined) {
    loaded = true;
    return false;
  }
  if (loaded && raw === lastRaw) return false;
  lastRaw = raw;
  loaded = true;
  const stored = parseStored(raw);
  // A document that cannot be read is replaced by the next write, not trusted.
  if (stored === null) return false;
  const next = merge(records, stored);
  const same =
    next.length === records.length &&
    next.every((record, index) => record === records[index] || JSON.stringify(record) === JSON.stringify(records[index]));
  if (same) return false;
  records = next;
  return true;
}

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== COMPARE_STORAGE_KEY) return;
    if (refresh()) emit();
  });
}

function ensureLoaded() {
  if (loaded) return;
  refresh();
  listen();
}

export function listCompares(): readonly CompareRecord[] {
  ensureLoaded();
  return records;
}

/** One compare, after taking in anything another window saved. */
export function getCompare(id: string): CompareRecord | null {
  ensureLoaded();
  if (refresh()) emit();
  return records.find((record) => record.id === id) ?? null;
}

export function subscribeCompares(listener: () => void): () => void {
  ensureLoaded();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** First write of an id, or the next revision only. Anything else is ignored. */
export function putCompare(record: CompareRecord): boolean {
  ensureLoaded();
  const changed = refresh();
  const index = records.findIndex((item) => item.id === record.id);
  let next: CompareRecord[];
  if (index < 0) {
    next = [...records, record];
  } else {
    if (record.revision !== records[index].revision + 1) {
      if (changed) emit();
      return false;
    }
    next = records.slice();
    next[index] = record;
  }
  records = keepNewest(next);
  const raw = JSON.stringify(records);
  if (writeRaw(raw)) {
    const confirmed = readRaw();
    if (confirmed !== undefined && confirmed !== raw) {
      // Another window wrote in between. Its document is read and merged; this write is asked to try again.
      lastRaw = null;
      refresh();
      emit();
      return false;
    }
    lastRaw = confirmed === undefined ? null : raw;
  }
  emit();
  return true;
}

export function resetCompares() {
  records = [];
  loaded = false;
  lastRaw = null;
  try {
    localStorage.removeItem(COMPARE_STORAGE_KEY);
  } catch {
    // Nothing was saved that could be removed.
  }
  emit();
}

function worktreeFrom(value: unknown): FanOutWorktree | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { kind?: unknown; path?: unknown; branch?: unknown; reason?: unknown };
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
  return { kind: "assigned", path: row.path, branch: row.branch.trim() };
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
  return {
    id: row.id,
    revision: row.revision,
    prompt: row.prompt,
    createdAt: row.createdAt,
    children,
    discardedIds,
    ...(sourceId ? { sourceId } : {}),
    ...(winnerId ? { winnerId } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(notStarted.length > 0 ? { notStarted } : {}),
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
