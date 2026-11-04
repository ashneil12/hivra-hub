// Translated from Raven raven/importer/state.py ImportState (Apache-2.0).
// The upstream file does not carry a separate copyright line.
// Licence: src/features/historyImport/vendor/raven-LICENSE.
//
// Only status "submitted" is done, so a failed source is tried again.
// A flat object with no "entries" key is the old layout and is wrapped.
// Corrupt JSON is the caller's to rename; this returns an empty state.
// The in-memory copy is never written back over a newer one: the caller
// compare-and-swaps, then rebuilds the one key on whatever it reloads.

import type { ImportStateFile, StateEntry, StateStatus } from "./types";

export function emptyState(): ImportStateFile {
  return { entries: {} };
}

export function stateKey(platform: string, sourceKey: string): string {
  return `${platform}:${sourceKey}`;
}

function asEntry(value: unknown): StateEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const status = rec.status;
  if (status !== "submitted" && status !== "failed" && status !== "deferred") return null;
  const error = typeof rec.error === "string" ? rec.error.slice(0, 200) : null;
  const timestamp = typeof rec.timestamp === "number" && Number.isFinite(rec.timestamp) ? rec.timestamp : 0;
  return { status, timestamp, error };
}

export function normalizeState(value: unknown): ImportStateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState();
  const rec = value as Record<string, unknown>;
  if (!rec.entries && rec.state && typeof rec.state === "object" && !Array.isArray(rec.state)) {
    return normalizeState(rec.state);
  }
  const source =
    rec.entries && typeof rec.entries === "object" && !Array.isArray(rec.entries)
      ? (rec.entries as Record<string, unknown>)
      : rec;
  const entries: Record<string, StateEntry> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "meta" || key === "entries" || key === "revision") continue;
    const parsed = asEntry(entry);
    if (parsed) entries[key] = parsed;
  }
  return { entries };
}

export function parseState(raw: string): { state: ImportStateFile; corrupt: boolean } {
  try {
    return { state: normalizeState(JSON.parse(raw) as unknown), corrupt: false };
  } catch {
    return { state: emptyState(), corrupt: true };
  }
}

export function isSubmitted(state: ImportStateFile, platform: string, sourceKey: string): boolean {
  return state.entries[stateKey(platform, sourceKey)]?.status === "submitted";
}

export function withEntry(
  state: ImportStateFile,
  platform: string,
  sourceKey: string,
  entry: StateEntry,
): ImportStateFile {
  return { entries: { ...state.entries, [stateKey(platform, sourceKey)]: entry } };
}

export function entry(status: StateStatus, timestamp: number, error: string | null = null): StateEntry {
  return { status, timestamp, error };
}
