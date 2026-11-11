// Dropwave (11 Nov): Git, files, changes and worktrees are for developers, so a project's sidebar hides them until
// Settings > Advanced > Worktrees turns "Show code tools" on. Kept with this window's other preferences.
import { useSyncExternalStore } from "react";
import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";

const KEY = "monocode:show-code-tools";
const listeners = new Set<() => void>();

export function showCodeTools(): boolean {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch {
    /* fall through to the default */
  }
  // Upstream MonoCode keeps its tools; the hub hides them until asked.
  return !IS_HUB_BUNDLE;
}

export function setShowCodeTools(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* best effort */
  }
  listeners.forEach((listener) => listener());
}

export function useShowCodeTools(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    showCodeTools,
    showCodeTools,
  );
}
