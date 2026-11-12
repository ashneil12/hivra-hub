// WP-93: runs a palette command through the same handler its shortcut runs.
// Each kind goes to the one place App already dispatches it from: a tab
// command through `actions`, an app command through the ref the key handler
// reads, zoom through the scale helpers, and the editor through its own find.
import type { TabCommand } from "../../workspace/model/tabKeys";
import type { ZoomAction } from "../../settings/model/zoomKeybinding";
import type { PaletteAppAction, PaletteRow } from "./commandRegistry";

/**
 * The workspace handlers the keyboard reaches, named so the palette can reach
 * the very same callbacks. `activate-last` and the four `focus-` names stand
 * for the object forms of a tab command.
 */
export const PALETTE_TAB_ACTIONS = [
  "new",
  "close-others",
  "close-all",
  "close",
  "next",
  "prev",
  "cycle-next",
  "cycle-prev",
  "back",
  "forward",
  "split-right",
  "split-down",
  "new-terminal",
  "new-terminal-tab",
  "toggle-terminal",
  "prev-session",
  "next-session",
  "prev-session-in-tab",
  "next-session-in-tab",
  "prev-project",
  "next-project",
  "activate-last",
  "focus-left",
  "focus-right",
  "focus-up",
  "focus-down",
] as const;

export type PaletteTabAction = (typeof PALETTE_TAB_ACTIONS)[number];

/** Which named handed-in handler a tab command runs, or null for an unknown one. */
export function tabActionFor(command: TabCommand): PaletteTabAction | null {
  if (typeof command === "string") {
    return (PALETTE_TAB_ACTIONS as readonly string[]).includes(command)
      ? (command as PaletteTabAction)
      : null;
  }
  if ("activate" in command) return "activate-last";
  return `focus-${command.focus}` as PaletteTabAction;
}

export type PaletteRunHandlers = {
  tab: (action: PaletteTabAction) => void;
  app: (action: PaletteAppAction) => void;
  zoom: (action: ZoomAction) => void;
  editor: (action: "find" | "replace") => void;
};

/** Every app action the palette can reach, so a missing one is a type error. */
export const PALETTE_APP_ACTIONS = [
  "settings",
  "search",
  "go-to-file",
  "command-palette",
  "find-in-files",
  "open-project",
  "new-window",
  "toggle-sidebar",
  "toggle-session-sidebar",
  "switch-model",
  "toggle-mono",
  "reload",
  "new-chat",
  "inbox",
  "home",
  "changes",
  "archive-chat",
  "stop-chat",
  "next-chat-worktree",
  "fork-from-here",
  "report-problem",
] as const satisfies readonly PaletteAppAction[];

const APP_ACTIONS = new Set<string>(PALETTE_APP_ACTIONS);

/**
 * Runs a row through named handlers, so App maps each name to the callback its
 * key handler already calls. An unknown name, a greyed row or a throwing
 * handler is false and changes nothing.
 */
export function runPaletteRow(
  row: PaletteRow,
  handlers: PaletteRunHandlers,
): boolean {
  if (row.blockedReason) return false;
  try {
    switch (row.run.kind) {
      case "tab": {
        const action = tabActionFor(row.run.command);
        if (!action) return false;
        handlers.tab(action);
        return true;
      }
      case "app":
        if (!APP_ACTIONS.has(row.run.action)) return false;
        handlers.app(row.run.action);
        return true;
      case "zoom":
        handlers.zoom(row.run.action);
        return true;
      case "editor":
        handlers.editor(row.run.action);
        return true;
      default:
        return false;
    }
  } catch (error) {
    console.error(error);
    return false;
  }
}
