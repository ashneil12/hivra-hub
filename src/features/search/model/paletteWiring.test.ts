// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PALETTE_COMMANDS,
  resolvePaletteRows,
  type PaletteContext,
} from "./commandRegistry";
import {
  runPaletteCommand,
  type PaletteActions,
  type PaletteSideEffects,
} from "./paletteWiring";

const anywhere: PaletteContext = {
  project: "/work/this",
  terminal: true,
  chat: true,
  busy: true,
  terminalFocus: false,
  pickerFocus: false,
  editor: true,
};

const nowhere: PaletteContext = {
  project: null,
  terminal: false,
  chat: false,
  busy: false,
  terminalFocus: false,
  pickerFocus: false,
  editor: false,
};

function actions(calls: string[]): PaletteActions {
  const mark = (name: string) => () => calls.push(name);
  const markAt = (name: string) => (value: unknown) => calls.push(`${name}:${String(value)}`);
  return {
    onNewFocused: mark("new"),
    onCloseOtherTabs: mark("close-others"),
    onCloseAllTabs: mark("close-all"),
    onCloseFocused: mark("close"),
    onNext: mark("next"),
    onPrev: mark("prev"),
    onVisitBack: mark("back"),
    onVisitForward: mark("forward"),
    onSplit: markAt("split"),
    onFocusDir: markAt("focus"),
    onActivate: markAt("activate"),
    onToggleSidebar: mark("toggle-sidebar"),
    onToggleSessionSidebar: mark("toggle-session-sidebar"),
    onToggleMono: mark("toggle-mono"),
    onGoToFile: mark("go-to-file"),
    onOpenCommandPalette: mark("command-palette"),
    onReload: mark("reload"),
    onFindInProject: mark("find-in-files"),
    onOpenFinder: mark("search"),
    onOpenInbox: mark("inbox"),
    pickProject: mark("open-project"),
    onNewTerminal: mark("new-terminal"),
    onNewTerminalTab: mark("new-terminal-tab"),
    onToggleProjectTerminal: mark("toggle-terminal"),
    onNavigateSessionList: (delta, inTab) =>
      calls.push(`session:${delta}:${inTab ? "tab" : "all"}`),
    onNavigateProjectList: (delta) => calls.push(`project:${delta}`),
    openSettings: mark("settings"),
  };
}

function sideEffects(
  calls: string[],
  overrides: Partial<PaletteSideEffects> = {},
): PaletteSideEffects {
  return {
    run: (_name, fn) => fn(),
    stopChat: () => "chat-1",
    archiveFocused: () => calls.push("archive-focused"),
    stop: (id) => calls.push(`stop:${id}`),
    showHome: () => calls.push("home"),
    showChanges: () => calls.push("changes"),
    openModelPicker: () => calls.push("model-picker"),
    newWindow: () => calls.push("new-window"),
    zoom: (action) => calls.push(`zoom:${action}`),
    editor: (action) => calls.push(`editor:${action}`),
    forkChat: () => calls.push("fork"),
    ...overrides,
  };
}

function row(id: string, context: PaletteContext = anywhere) {
  const found = resolvePaletteRows(context).find((entry) => entry.id === id);
  if (!found) throw new Error(`missing palette command ${id}`);
  return found;
}

beforeEach(() => {
  localStorage.clear();
});

describe("the palette wiring", () => {
  it("sends each tab command to the callback the key handler calls", () => {
    const cases: Array<[string, string]> = [
      ["Tab: New", "new"],
      ["Tab: Close Others", "close-others"],
      ["Tab: Close All", "close-all"],
      ["Pane: Close", "close"],
      ["Tab: Next", "next"],
      ["Tab: Previous", "prev"],
      ["Tab: Cycle Next", "next"],
      ["Tab: Cycle Previous", "prev"],
      ["Tab: Back", "back"],
      ["Tab: Forward", "forward"],
      ["Pane: Split Right", "split:right"],
      ["Pane: Split Down", "split:down"],
      ["Terminal: New", "new-terminal"],
      ["Terminal: New Tab", "new-terminal-tab"],
      ["Terminal: Toggle Dock", "toggle-terminal"],
      ["Session: Previous", "session:-1:all"],
      ["Session: Next", "session:1:all"],
      ["Session: Previous in Current Tab", "session:-1:tab"],
      ["Session: Next in Current Tab", "session:1:tab"],
      ["Project: Previous", "project:-1"],
      ["Project: Next", "project:1"],
      ["Tab: Activate Last", "activate:-1"],
      ["Pane: Focus Left", "focus:left"],
      ["Pane: Focus Right", "focus:right"],
      ["Pane: Focus Up", "focus:up"],
      ["Pane: Focus Down", "focus:down"],
    ];
    for (const [id, expected] of cases) {
      const calls: string[] = [];
      expect(runPaletteCommand(row(id), actions(calls), sideEffects(calls))).toBe(true);
      expect(calls).toEqual([expected]);
    }
  });

  it("sends each app command to the callback the key handler calls", () => {
    const cases: Array<[string, string]> = [
      ["App: Settings", "settings"],
      ["App: Search", "search"],
      ["App: Go to File", "go-to-file"],
      ["App: Command Palette", "command-palette"],
      ["App: Find in Files", "find-in-files"],
      ["App: Open Project", "open-project"],
      ["App: New Window", "new-window"],
      ["App: Toggle Sidebar", "toggle-sidebar"],
      ["App: Toggle Session Sidebar", "toggle-session-sidebar"],
      ["App: Switch Model", "model-picker"],
      ["App: Toggle Mono", "toggle-mono"],
      ["View: Reload", "reload"],
      ["app.new-chat", "new"],
      ["app.inbox", "inbox"],
      ["app.home", "home"],
      ["app.commit", "changes"],
      ["app.create-pr", "changes"],
      ["Session: Archive", "archive-focused"],
      ["Session: Stop", "stop:chat-1"],
    ];
    for (const [id, expected] of cases) {
      const calls: string[] = [];
      expect(runPaletteCommand(row(id), actions(calls), sideEffects(calls))).toBe(true);
      expect(calls).toEqual([expected]);
    }
  });

  it("flips the next chat between off and ask without touching the composer", () => {
    localStorage.clear();
    const calls: string[] = [];
    const run = vi.fn((_name: string, fn: () => void) => fn());
    const side = sideEffects(calls);
    side.run = run;
    const command = row("git.next-chat-worktree");

    expect(runPaletteCommand(command, actions(calls), side)).toBe(true);
    expect(localStorage.getItem("monocode.newChatWorktree")).toBe("ask");

    expect(runPaletteCommand(command, actions(calls), side)).toBe(true);
    expect(localStorage.getItem("monocode.newChatWorktree")).toBe("off");

    localStorage.setItem("monocode.newChatWorktree", "always");
    expect(runPaletteCommand(command, actions(calls), side)).toBe(true);
    expect(localStorage.getItem("monocode.newChatWorktree")).toBe("ask");

    localStorage.setItem("monocode.newChatWorktree", "nope");
    expect(runPaletteCommand(command, actions(calls), side)).toBe(true);
    expect(localStorage.getItem("monocode.newChatWorktree")).toBe("ask");

    expect(calls).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("forks the chat in focus from the palette", () => {
    const calls: string[] = [];
    expect(
      runPaletteCommand(row("session.fork-from-here"), actions(calls), sideEffects(calls)),
    ).toBe(true);
    expect(calls).toEqual(["fork"]);
    const blocked = row("session.fork-from-here", nowhere);
    expect(runPaletteCommand(blocked, actions(calls), sideEffects(calls))).toBe(false);
    expect(calls).toEqual(["fork"]);
  });

  it("sends zoom and editor rows to their own helpers", () => {
    const calls: string[] = [];
    runPaletteCommand(row("View: Zoom In"), actions(calls), sideEffects(calls));
    runPaletteCommand(row("View: Zoom Out"), actions(calls), sideEffects(calls));
    runPaletteCommand(row("View: Reset Zoom"), actions(calls), sideEffects(calls));
    runPaletteCommand(row("Editor: Find"), actions(calls), sideEffects(calls));
    runPaletteCommand(row("Editor: Replace"), actions(calls), sideEffects(calls));
    expect(calls).toEqual([
      "zoom:zoom-in",
      "zoom:zoom-out",
      "zoom:zoom-reset",
      "editor:find",
      "editor:replace",
    ]);
  });

  it("runs nothing for a greyed command or a number-key row", () => {
    for (const id of ["Session: Stop", "Terminal: New", "Project: Next", "Editor: Find"]) {
      const calls: string[] = [];
      expect(
        runPaletteCommand(row(id, nowhere), actions(calls), sideEffects(calls)),
      ).toBe(false);
      expect(calls).toEqual([]);
    }
    const calls: string[] = [];
    expect(
      runPaletteCommand(row("Tab: Activate 1–8"), actions(calls), sideEffects(calls)),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("stops nothing when no chat is running in focus", () => {
    const calls: string[] = [];
    const none = sideEffects(calls, { stopChat: () => null });
    expect(runPaletteCommand(row("Session: Stop"), actions(calls), none)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("never throws when a handler does, and reports it once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: string[] = [];
    const broken = actions(calls);
    broken.onNewFocused = () => {
      throw new Error("no");
    };
    expect(runPaletteCommand(row("Tab: New"), broken, sideEffects(calls))).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("has a handler for every command the registry shows", () => {
    const calls: string[] = [];
    const handIn = actions(calls);
    const side = sideEffects(calls);
    for (const command of PALETTE_COMMANDS) {
      const target = row(command.id);
      // A number-key row is the only kind with nothing to run.
      const ran = runPaletteCommand(target, handIn, side);
      expect(ran).toBe(target.run.kind !== "none");
    }
  });
});
