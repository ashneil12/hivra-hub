// Dropwave (11 Nov): Git, files, changes and worktrees are for developers, so a project's sidebar hides them until
// Settings > Advanced > Worktrees turns "Show code tools" on. G6: kept in the app settings (settings.ts), with the
// app's other preferences, and carried by an export.
import { useSyncExternalStore } from "react";
import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";
import { loadShowCodeTools, saveShowCodeTools, subscribeShowCodeTools } from "./settings";

/** Upstream MonoCode keeps its tools; the hub hides them until asked. */
const SHOWN_BY_DEFAULT = !IS_HUB_BUNDLE;

export function showCodeTools(): boolean {
  return loadShowCodeTools(SHOWN_BY_DEFAULT);
}

export function setShowCodeTools(on: boolean): void {
  saveShowCodeTools(on);
}

export function useShowCodeTools(): boolean {
  return useSyncExternalStore(subscribeShowCodeTools, showCodeTools, showCodeTools);
}
