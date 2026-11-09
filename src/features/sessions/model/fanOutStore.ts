// WP-135: the compare records a window is showing. A value read back is
// untrusted, and a record that claims to merge winners is dropped.
import { HARNESSES, type HarnessId } from "./session";
import { FAN_OUT_MAX, type CompareRecord, type FanOutChild, type FanOutWorktree } from "./fanOut";

const PROVIDERS = new Set<string>(HARNESSES);

let records: CompareRecord[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function listCompares(): readonly CompareRecord[] {
  return records;
}

export function subscribeCompares(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** First write of an id, or the next revision only. Anything else is ignored. */
export function putCompare(record: CompareRecord): boolean {
  const index = records.findIndex((item) => item.id === record.id);
  if (index < 0) {
    records = [...records, record];
    emit();
    return true;
  }
  if (record.revision !== records[index].revision + 1) return false;
  const next = records.slice();
  next[index] = record;
  records = next;
  emit();
  return true;
}

export function resetCompares() {
  records = [];
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
  return {
    id: row.id,
    revision: row.revision,
    prompt: row.prompt,
    createdAt: row.createdAt,
    children,
    discardedIds,
    ...(winnerId ? { winnerId } : {}),
    autoMerge: false,
  };
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
