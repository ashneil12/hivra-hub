/**
 * WP-16: the Grok launcher is retired. A stored `claude-grok` CLI path is cleared
 * once, and a stored `claude:grok-4.7` reads as the app's default Claude model.
 * Nothing here touches the launcher file. DeepSeek is not part of this.
 */

export const RETIRED_GROK_LAUNCHER_NAME = "claude-grok";
export const RETIRED_GROK_MODEL_ID = "claude:grok-4.7";
export const GROK_RETIREMENT_NOTE =
  "Claude Code now runs on your Claude login. The Grok launcher isn't used any more.";
export const GROK_RETIREMENT_NOTE_KEY = "monocode.grokRetirementNote.v1";
export const PROVIDER_BINARY_PATHS_KEY = "monocode.providerBinaryPaths.v1";

export type RetirementStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

let pendingNote: string | null = null;

/** The note from the clear that just happened, until the window dismisses it. */
export function pendingGrokRetirementNote(): string | null {
  return pendingNote;
}

export function dismissGrokRetirementNote(): void {
  pendingNote = null;
}

/** True when the path's file name is exactly the retired launcher. No disk access. */
export function isRetiredGrokLauncherPath(path: string): boolean {
  if (typeof path !== "string") return false;
  const trimmed = path.replace(/\r/g, "").trim().replace(/[\\/]+$/, "");
  if (!trimmed) return false;
  const base = trimmed.split(/[\\/]/).pop() ?? "";
  return base === RETIRED_GROK_LAUNCHER_NAME;
}

/**
 * A stored `claude:grok-4.7`, with or without a `[...]` context suffix, reads as
 * `fallback`. Every other value, including a non-string, is returned unchanged.
 */
export function readRetiredGrokModel<T>(model: T, fallback: string): T | string {
  if (typeof model !== "string") return model;
  const bare = model.replace(/\r/g, "").trim().replace(/\[[^\]]*\]$/, "").trim();
  return bare === RETIRED_GROK_MODEL_ID ? fallback : model;
}

function readPaths(store: RetirementStore): Record<string, unknown> | null {
  const raw = store.getItem(PROVIDER_BINARY_PATHS_KEY);
  if (raw == null || raw === "") return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

/**
 * Clears the Claude CLI path when its file name is still the retired launcher.
 * Re-reads storage immediately before the write, and writes nothing if that
 * entry changed. The note is returned only for the clear that shows it.
 * A storage failure is not a clear and does not throw.
 */
export function retireGrokLauncherOnce(store: RetirementStore): {
  cleared: boolean;
  note: string | null;
} {
  let paths: Record<string, unknown> | null;
  try {
    paths = readPaths(store);
  } catch {
    return { cleared: false, note: null };
  }
  if (!paths) return { cleared: false, note: null };
  const claude = paths.claude;
  if (typeof claude !== "string" || !isRetiredGrokLauncherPath(claude)) {
    return { cleared: false, note: null };
  }
  let again: Record<string, unknown> | null;
  try {
    again = readPaths(store);
  } catch {
    return { cleared: false, note: null };
  }
  if (!again || again.claude !== claude) return { cleared: false, note: null };
  const next = { ...again };
  delete next.claude;
  try {
    store.setItem(PROVIDER_BINARY_PATHS_KEY, JSON.stringify(next));
  } catch {
    return { cleared: false, note: null };
  }
  let shown = true;
  try {
    shown = store.getItem(GROK_RETIREMENT_NOTE_KEY) === "1";
  } catch {
    shown = true;
  }
  if (shown) return { cleared: true, note: null };
  try {
    store.setItem(GROK_RETIREMENT_NOTE_KEY, "1");
  } catch {
    // The path is already gone, so a later start will not show the note again.
  }
  pendingNote = GROK_RETIREMENT_NOTE;
  return { cleared: true, note: GROK_RETIREMENT_NOTE };
}
