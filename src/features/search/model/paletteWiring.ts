// WP-93: the table that sends each palette row to the very callback its
// shortcut calls. App hands in its `actions` ref and its `run` debounce; this
// file holds the one mapping, so the two key paths and the palette agree.
import {
  loadNewChatWorktree,
  saveNewChatWorktree,
} from "../../settings/model/settings";
import type { ZoomAction } from "../../settings/model/zoomKeybinding";
import { flippedNewChatWorktree } from "../../source-control/model/newChatWorktree";
import type { PaletteAppAction, PaletteRow } from "./commandRegistry";
import { runPaletteRow, type PaletteRunHandlers } from "./paletteRun";

/** The workspace callbacks the keydown handler and the native menu already reach. */
export type PaletteActions = {
  onNewFocused: () => void;
  onCloseOtherTabs: () => void;
  onCloseAllTabs: () => void;
  onCloseFocused: () => void;
  onNext: () => void;
  onPrev: () => void;
  onVisitBack: () => void;
  onVisitForward: () => void;
  onSplit: (side: "right" | "down") => void;
  onFocusDir: (dir: "left" | "right" | "up" | "down") => void;
  onActivate: (slot: number) => void;
  onToggleSidebar: () => void;
  onToggleSessionSidebar: () => void;
  onToggleMono: () => void;
  onGoToFile: () => void;
  onOpenCommandPalette: () => void;
  onReload: () => void;
  onFindInProject: () => void;
  onOpenFinder: () => void;
  onOpenInbox: () => void;
  pickProject: () => void;
  onNewTerminal: () => void;
  onNewTerminalTab: () => void;
  onToggleProjectTerminal: () => void;
  onNavigateSessionList: (delta: number, inTab?: boolean) => void;
  onNavigateProjectList: (delta: number) => void;
  openSettings: () => void;
};

export type PaletteSideEffects = {
  /** The 80 ms debounce the key handler uses, so a double press runs once. */
  run: (name: string, fn: () => void) => void;
  /** The chat Esc would stop, worked out by App the way its Esc handler does. */
  stopChat: () => string | null;
  stop: (sessionId: string) => void;
  /** The very handler the archive shortcut runs, so it refuses where the shortcut refuses. */
  archiveFocused: () => void;
  showHome: () => void;
  showChanges: () => void;
  openModelPicker: () => void;
  newWindow: () => void;
  zoom: (action: ZoomAction) => void;
  editor: (action: "find" | "replace") => void;
  /** WP-123: fork the chat in focus from its latest message. */
  forkChat: () => void;
};

function tabHandlers(
  actions: PaletteActions,
  run: PaletteSideEffects["run"],
): Record<string, () => void> {
  return {
    new: () => run("new", actions.onNewFocused),
    "close-others": () => run("close-others", actions.onCloseOtherTabs),
    "close-all": () => run("close-all", actions.onCloseAllTabs),
    close: () => run("close", actions.onCloseFocused),
    next: () => run("next", actions.onNext),
    prev: () => run("prev", actions.onPrev),
    "cycle-next": () => run("next", actions.onNext),
    "cycle-prev": () => run("prev", actions.onPrev),
    back: () => run("back", actions.onVisitBack),
    forward: () => run("forward", actions.onVisitForward),
    "split-right": () => run("split-right", () => actions.onSplit("right")),
    "split-down": () => run("split-down", () => actions.onSplit("down")),
    "new-terminal": () => run("new-terminal", actions.onNewTerminal),
    "new-terminal-tab": () =>
      run("new-terminal-tab", actions.onNewTerminalTab),
    "toggle-terminal": () =>
      run("toggle-terminal", actions.onToggleProjectTerminal),
    "prev-session": () =>
      run("prev-session", () => actions.onNavigateSessionList(-1)),
    "next-session": () =>
      run("next-session", () => actions.onNavigateSessionList(1)),
    "prev-session-in-tab": () =>
      run("prev-session-in-tab", () => actions.onNavigateSessionList(-1, true)),
    "next-session-in-tab": () =>
      run("next-session-in-tab", () => actions.onNavigateSessionList(1, true)),
    "prev-project": () =>
      run("prev-project", () => actions.onNavigateProjectList(-1)),
    "next-project": () =>
      run("next-project", () => actions.onNavigateProjectList(1)),
    "activate-last": () => run("activate--1", () => actions.onActivate(-1)),
    "focus-left": () => run("focus-left", () => actions.onFocusDir("left")),
    "focus-right": () => run("focus-right", () => actions.onFocusDir("right")),
    "focus-up": () => run("focus-up", () => actions.onFocusDir("up")),
    "focus-down": () => run("focus-down", () => actions.onFocusDir("down")),
  };
}

function appHandlers(
  actions: PaletteActions,
  side: PaletteSideEffects,
): Record<PaletteAppAction, () => void> {
  const run = side.run;
  return {
    settings: () => run("open_settings", () => actions.openSettings()),
    search: () => run("open_finder", actions.onOpenFinder),
    "go-to-file": () => run("go_to_file", actions.onGoToFile),
    "command-palette": () =>
      run("open_command_palette", actions.onOpenCommandPalette),
    "find-in-files": () => run("find_in_project", actions.onFindInProject),
    "open-project": () => run("open_project", () => actions.pickProject()),
    "new-window": () => run("new_window", side.newWindow),
    "toggle-sidebar": () => run("toggle_sidebar", actions.onToggleSidebar),
    "toggle-session-sidebar": () =>
      run("toggle_session_sidebar", actions.onToggleSessionSidebar),
    // The model picker is a window event, not a callback.
    "switch-model": () => side.openModelPicker(),
    "toggle-mono": () => run("toggle_mono", actions.onToggleMono),
    reload: () => run("reload", actions.onReload),
    "new-chat": () => run("new", actions.onNewFocused),
    inbox: () => actions.onOpenInbox(),
    home: () => side.showHome(),
    changes: () => side.showChanges(),
    "archive-chat": () => side.archiveFocused(),
    "stop-chat": () => {
      const id = side.stopChat();
      if (id) side.stop(id);
    },
    // WP-110: flip the next-chat worktree between off and ask. Not a composer action.
    "next-chat-worktree": () =>
      saveNewChatWorktree(flippedNewChatWorktree(loadNewChatWorktree())),
    // WP-123: fork the chat in focus. The palette has no message, so the latest one is used.
    "fork-from-here": () => side.forkChat(),
  };
}

/** One row, run through the handler its shortcut uses. Never throws. */
export function runPaletteCommand(
  row: PaletteRow,
  actions: PaletteActions,
  side: PaletteSideEffects,
): boolean {
  const tabs = tabHandlers(actions, side.run);
  const apps = appHandlers(actions, side);
  const handlers: PaletteRunHandlers = {
    tab: (action) => tabs[action]?.(),
    app: (action) => apps[action](),
    zoom: (action) => side.zoom(action),
    editor: (action) => side.editor(action),
  };
  return runPaletteRow(row, handlers);
}
