// A pane reporting focus: which view it belongs to, and whether it may move Ash out of a Mono's chat.

/**
 * - "mono": the open Mono's own chat.
 * - "shown": the session shown beside the Mono's chat.
 * - "ignore": a pane Ash can't see while a Mono's chat covers the workspace (every workspace tab is hidden then, and a
 *   pane outside the workspace is one sliding away from the Mono's sidebar). He can't have clicked it, so its focus is
 *   the app's own (a composer re-focusing, a late focus after a background change) and must not close the Mono's chat
 *   and show the workspace (r61, PM's r60 D5/C3: the app jumped from the Lead's chat to the coding team's tabs).
 * - "workspace": a workspace pane with nothing over it: it becomes the focused pane.
 */
export type PaneFocus = "mono" | "shown" | "ignore" | "workspace";

export function paneFocus(paneId: string, view: { monoViewId: string | null; shownMonoSessionId: string | null }): PaneFocus {
  if (view.monoViewId && paneId === view.monoViewId) return "mono";
  if (view.shownMonoSessionId && paneId === view.shownMonoSessionId) return "shown";
  if (view.monoViewId) return "ignore";
  return "workspace";
}
