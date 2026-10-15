import type { AgentModel } from "./models";

/**
 * "Older versions" in the model picker: of each family (Opus, Sonnet, Haiku, Fable, ...) only the newest version stays
 * on top; the rest fold under one quiet row. Off unless the setting is on, so the list stays exactly as it was.
 */
const FOLD_KEY = "monocode:model-picker-fold-older";
const CHANGED = "monocode:model-picker-fold-older-change";

export function loadFoldOlderVersions(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveFoldOlderVersions(on: boolean): void {
  try {
    localStorage.setItem(FOLD_KEY, on ? "1" : "0");
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(CHANGED));
}

export function subscribeFoldOlderVersions(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}

/** "Claude Opus 4.8" → family "opus", version [4, 8]. Models with no version number have no family. */
function familyOf(model: AgentModel): { family: string; version: number[] } | undefined {
  const m = /^(?:claude\s+)?([a-z][a-z-]*?)\s+(\d+(?:\.\d+)*)\b/i.exec(model.name.trim());
  if (!m) return undefined;
  return { family: `${model.provider?.id ?? model.harness}:${m[1].toLowerCase()}`, version: m[2].split(".").map(Number) };
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** Splits a list into the newest of each family (kept in list order) and everything older. */
export function splitOlderVersions(models: AgentModel[]): { latest: AgentModel[]; older: AgentModel[] } {
  const best = new Map<string, { id: string; version: number[] }>();
  for (const model of models) {
    const f = familyOf(model);
    if (!f) continue;
    const seen = best.get(f.family);
    if (!seen || newer(f.version, seen.version)) best.set(f.family, { id: model.id, version: f.version });
  }
  const latest: AgentModel[] = [];
  const older: AgentModel[] = [];
  for (const model of models) {
    const f = familyOf(model);
    (!f || best.get(f.family)?.id === model.id ? latest : older).push(model);
  }
  return { latest, older };
}
