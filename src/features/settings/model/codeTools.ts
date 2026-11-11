// Dropwave (11 Nov): Git, files, changes and worktrees are for developers, so a project's sidebar hides them until
// Settings > Advanced > Worktrees turns "Show code tools" on. G6: kept in the app settings (settings.ts), with the
// app's other preferences, and carried by an export.
import { useSyncExternalStore } from "react";
import { loadShowCodeTools, saveShowCodeTools, subscribeShowCodeTools } from "./settings";

export function showCodeTools(): boolean {
  return loadShowCodeTools();
}

export function setShowCodeTools(on: boolean): void {
  saveShowCodeTools(on);
}

export function useShowCodeTools(): boolean {
  return useSyncExternalStore(subscribeShowCodeTools, loadShowCodeTools, loadShowCodeTools);
}
