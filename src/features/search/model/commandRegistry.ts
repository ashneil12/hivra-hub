// WP-93: one place that turns the shortcut table into palette commands, so a
// command in the palette runs through the very handler its shortcut runs.
import {
  KEYBINDINGS,
  keybindingShortcutLabel,
} from "../../settings/model/settings";
import type { ZoomAction } from "../../settings/model/zoomKeybinding";
import type { TabCommand } from "../../workspace/model/tabKeys";

/** What the app can run right now, read when the palette opens. */
export type PaletteContext = {
  /** The open project's folder, or null when no project is open. */
  project: string | null;
  /** That project is a folder on this computer, where a terminal may run. */
  terminal: boolean;
  /** A chat has focus. */
  chat: boolean;
  /** That chat has a turn running. */
  busy: boolean;
  /** Focus was in a terminal when the palette opened (Esc and Switch model both leave that to the terminal). */
  terminalFocus: boolean;
  /** Focus was in another picker or its control (Switch model leaves that to the picker). */
  pickerFocus: boolean;
  /** A file is open in the code editor. */
  editor: boolean;
};

export type PaletteAppAction =
  | "settings"
  | "search"
  | "go-to-file"
  | "command-palette"
  | "find-in-files"
  | "open-project"
  | "new-window"
  | "toggle-sidebar"
  | "toggle-session-sidebar"
  | "switch-model"
  | "toggle-mono"
  | "reload"
  | "new-chat"
  | "inbox"
  | "home"
  | "changes"
  | "archive-chat"
  | "stop-chat"
  | "next-chat-worktree"
  | "fork-from-here"
  | "report-problem"
  | "computer-use-observe"
  | "computer-use-off"
  | "computer-use-follow";

export type PaletteRun =
  | { kind: "tab"; command: TabCommand }
  | { kind: "app"; action: PaletteAppAction }
  | { kind: "zoom"; action: ZoomAction }
  | { kind: "editor"; action: "find" | "replace" }
  /** A range row: it needs a number key, so the palette cannot run it. */
  | { kind: "none" };

type PaletteNeed =
  | "none"
  | "chat"
  | "chat-control"
  | "busy-chat"
  | "project"
  | "terminal"
  | "editor"
  | "number-key";

export type PaletteCommand = {
  /** Stable across releases: the shortcut table's own command name, or an extra's id. */
  id: string;
  label: string;
  group: string;
  /** The shortcut table's default chord, shown until the person rebinds it. */
  keys: string;
  /** The shortcut table row this command stands for, if any. */
  binding: string | null;
  run: PaletteRun;
  needs: PaletteNeed;
};

export type PaletteRow = PaletteCommand & {
  /** The person's chord right now, or null when there is none or it is turned off. */
  hint: string | null;
  /** One plain line saying why it cannot run now, or null when it can. */
  blockedReason: string | null;
};

type Spec = {
  label?: string;
  run: PaletteRun;
  needs: PaletteNeed;
};

/**
 * Every row of the shortcut table, except the two that have no frontend
 * handler. The key is the table's command name, so an id never moves.
 */
/** Plain words where the shortcut table's own name reads as a fragment. */
const LABELS: Record<string, string> = {
  "Tab: New": "New tab",
  "Tab: Close Others": "Close other tabs",
  "Tab: Close All": "Close all tabs",
  "Tab: Next": "Next tab",
  "Tab: Previous": "Previous tab",
  "Pane: Close": "Close pane",
  "Terminal: New": "New terminal",
  "Terminal: New Tab": "New terminal tab",
  "Terminal: Toggle Dock": "Toggle terminal",
  "Session: Stop": "Stop chat",
  "Session: Archive": "Archive chat",
  "Tab: Activate 1–8": "Activate tab 1 to 8",
};

const SPEC: Record<string, Spec> = {
  "App: Settings": { run: { kind: "app", action: "settings" }, needs: "none" },
  "App: Search": { run: { kind: "app", action: "search" }, needs: "none" },
  "App: Go to File": { run: { kind: "app", action: "go-to-file" }, needs: "none" },
  "App: Command Palette": { run: { kind: "app", action: "command-palette" }, needs: "none" },
  "App: Find in Files": { run: { kind: "app", action: "find-in-files" }, needs: "none" },
  "App: Open Project": { run: { kind: "app", action: "open-project" }, needs: "none" },
  "App: New Window": { run: { kind: "app", action: "new-window" }, needs: "none" },
  "App: Toggle Sidebar": { run: { kind: "app", action: "toggle-sidebar" }, needs: "none" },
  "App: Toggle Session Sidebar": {
    run: { kind: "app", action: "toggle-session-sidebar" },
    needs: "none",
  },
  "App: Switch Model": { run: { kind: "app", action: "switch-model" }, needs: "chat-control" },
  "App: Toggle Mono": { run: { kind: "app", action: "toggle-mono" }, needs: "none" },
  "View: Reload": { run: { kind: "app", action: "reload" }, needs: "none" },
  "View: Zoom In": { run: { kind: "zoom", action: "zoom-in" }, needs: "none" },
  "View: Zoom Out": { run: { kind: "zoom", action: "zoom-out" }, needs: "none" },
  "View: Reset Zoom": { run: { kind: "zoom", action: "zoom-reset" }, needs: "none" },
  "Tab: New": { run: { kind: "tab", command: "new" }, needs: "none" },
  "Tab: Close Others": { run: { kind: "tab", command: "close-others" }, needs: "none" },
  "Tab: Close All": { run: { kind: "tab", command: "close-all" }, needs: "none" },
  "Tab: Next": { run: { kind: "tab", command: "next" }, needs: "none" },
  "Tab: Previous": { run: { kind: "tab", command: "prev" }, needs: "none" },
  "Tab: Cycle Next": { run: { kind: "tab", command: "cycle-next" }, needs: "none" },
  "Tab: Cycle Previous": { run: { kind: "tab", command: "cycle-prev" }, needs: "none" },
  "Tab: Back": { run: { kind: "tab", command: "back" }, needs: "none" },
  "Tab: Forward": { run: { kind: "tab", command: "forward" }, needs: "none" },
  "Tab: Activate 1–8": {
    label: "Activate tab 1 to 8",
    run: { kind: "none" },
    needs: "number-key",
  },
  "Tab: Activate Last": { run: { kind: "tab", command: { activate: -1 } }, needs: "none" },
  "Session: Archive": { run: { kind: "app", action: "archive-chat" }, needs: "chat" },
  "Session: Stop": { run: { kind: "app", action: "stop-chat" }, needs: "busy-chat" },
  "Session: Previous": { run: { kind: "tab", command: "prev-session" }, needs: "none" },
  "Session: Next": { run: { kind: "tab", command: "next-session" }, needs: "none" },
  "Session: Previous in Current Tab": {
    run: { kind: "tab", command: "prev-session-in-tab" },
    needs: "none",
  },
  "Session: Next in Current Tab": {
    run: { kind: "tab", command: "next-session-in-tab" },
    needs: "none",
  },
  "Project: Previous": { run: { kind: "tab", command: "prev-project" }, needs: "project" },
  "Project: Next": { run: { kind: "tab", command: "next-project" }, needs: "project" },
  "Pane: Close": { run: { kind: "tab", command: "close" }, needs: "none" },
  "Pane: Split Right": { run: { kind: "tab", command: "split-right" }, needs: "none" },
  "Pane: Split Down": { run: { kind: "tab", command: "split-down" }, needs: "none" },
  "Pane: Focus Left": { run: { kind: "tab", command: { focus: "left" } }, needs: "none" },
  "Pane: Focus Right": { run: { kind: "tab", command: { focus: "right" } }, needs: "none" },
  "Pane: Focus Up": { run: { kind: "tab", command: { focus: "up" } }, needs: "none" },
  "Pane: Focus Down": { run: { kind: "tab", command: { focus: "down" } }, needs: "none" },
  "Terminal: New": { run: { kind: "tab", command: "new-terminal" }, needs: "terminal" },
  "Terminal: New Tab": { run: { kind: "tab", command: "new-terminal-tab" }, needs: "terminal" },
  "Terminal: Toggle Dock": { run: { kind: "tab", command: "toggle-terminal" }, needs: "terminal" },
  "Editor: Find": { run: { kind: "editor", action: "find" }, needs: "editor" },
  "Editor: Replace": { run: { kind: "editor", action: "replace" }, needs: "editor" },
};

/** True when the palette maps this shortcut row to something it runs. */
export function hasPaletteSpec(command: string): boolean {
  return command in SPEC;
}

/** Rows the palette leaves out, and why. Kept in code so the gap is visible. */
export const PALETTE_OMITTED: Record<string, string> = {
  "App: Quick Composer":
    "Only the system-wide shortcut opens it, and it is off in this app.",
  "Composer: Toggle Workspace":
    "It belongs to the draft composer, which the palette would close.",
};

/** Commands with no shortcut of their own. Ids are stable; labels are plain words. */
const EXTRAS: PaletteCommand[] = [
  {
    id: "app.new-chat",
    label: "New chat",
    group: "App",
    keys: "",
    binding: null,
    run: { kind: "app", action: "new-chat" },
    needs: "none",
  },
  {
    id: "app.home",
    label: "Open Home",
    group: "App",
    keys: "",
    binding: null,
    run: { kind: "app", action: "home" },
    needs: "none",
  },
  {
    id: "app.inbox",
    label: "Open inbox",
    group: "App",
    keys: "",
    binding: null,
    run: { kind: "app", action: "inbox" },
    needs: "none",
  },
  {
    id: "app.commit",
    label: "Commit",
    group: "Git",
    keys: "",
    binding: null,
    run: { kind: "app", action: "changes" },
    needs: "project",
  },
  {
    id: "app.create-pr",
    label: "Create PR",
    group: "Git",
    keys: "",
    binding: null,
    run: { kind: "app", action: "changes" },
    needs: "project",
  },
  {
    id: "git.next-chat-worktree",
    label: "Next chat: use its own worktree",
    group: "Git",
    keys: "",
    binding: null,
    run: { kind: "app", action: "next-chat-worktree" },
    needs: "none",
  },
  {
    id: "session.fork-from-here",
    label: "Fork from here",
    group: "Session",
    keys: "",
    binding: null,
    run: { kind: "app", action: "fork-from-here" },
    needs: "chat",
  },
  {
    // WP-252: the person's own agent reads the logs and this build's source, and drafts an issue.
    id: "app.report-problem",
    label: "Report a problem",
    group: "App",
    keys: "",
    binding: null,
    run: { kind: "app", action: "report-problem" },
    needs: "none",
  },
  // WP-255: the chat in view's own say on computer use (Settings > Computer use lists them).
  {
    id: "session.computer-use-observe",
    label: "Computer use: look only in this chat",
    group: "Session",
    keys: "",
    binding: null,
    run: { kind: "app", action: "computer-use-observe" },
    needs: "chat",
  },
  {
    id: "session.computer-use-off",
    label: "Computer use: off in this chat",
    group: "Session",
    keys: "",
    binding: null,
    run: { kind: "app", action: "computer-use-off" },
    needs: "chat",
  },
  {
    id: "session.computer-use-follow",
    label: "Computer use: follow Settings in this chat",
    group: "Session",
    keys: "",
    binding: null,
    run: { kind: "app", action: "computer-use-follow" },
    needs: "chat",
  },
];

function labelFor(command: string): string {
  const spec = SPEC[command];
  if (spec?.label) return spec.label;
  if (LABELS[command]) return LABELS[command];
  const colon = command.indexOf(": ");
  return colon === -1 ? command : command.slice(colon + 2);
}

function groupFor(command: string): string {
  const colon = command.indexOf(": ");
  return colon === -1 ? "App" : command.slice(0, colon);
}

/** Every command the palette can show, in the shortcut table's own order. */
export const PALETTE_COMMANDS: PaletteCommand[] = [
  ...KEYBINDINGS.flatMap((row): PaletteCommand[] => {
    const spec = SPEC[row.command];
    // A row this build has not mapped yet still appears, so it can be found.
    // (A test fails the build when a row is neither mapped nor in PALETTE_OMITTED.)
    return [
      {
        id: row.command,
        label: labelFor(row.command),
        group: groupFor(row.command),
        keys: row.keys,
        binding: row.command,
        run: spec?.run ?? { kind: "app", action: "settings" },
        needs: spec?.needs ?? "none",
      },
    ];
  }).filter((command) => !(command.id in PALETTE_OMITTED)),
  ...EXTRAS,
];

const REASONS: Record<Exclude<PaletteNeed, "none">, (context: PaletteContext) => string | null> = {
  chat: (context) => (context.chat ? null : "Open a chat first"),
  "chat-control": (context) => {
    if (!context.chat) return "Open a chat first";
    // Its shortcut only steps aside for a terminal and the other pickers; a
    // focused composer is exactly where it is meant to work.
    return context.terminalFocus || context.pickerFocus ? "Click the chat first" : null;
  },
  "busy-chat": (context) =>
    !context.chat
      ? "Open a chat first"
      : context.terminalFocus
        ? "Click the chat first"
        : context.busy
          ? null
          : "No chat is running right now",
  project: (context) => (context.project ? null : "Open a project first"),
  terminal: (context) =>
    !context.project
      ? "Open a project first"
      : context.terminal
        ? null
        : "This project has no folder on this computer",
  editor: (context) => (context.editor ? null : "Open a file in the editor first"),
  "number-key": () => "Use the number keys to pick a tab",
};

/** The registry with the person's current chords and what can run right now. */
export function resolvePaletteRows(context: PaletteContext): PaletteRow[] {
  return PALETTE_COMMANDS.map((command) => ({
    ...command,
    hint:
      command.binding === null
        ? null
        : keybindingShortcutLabel(command.binding, command.keys),
    blockedReason:
      command.needs === "none" ? null : REASONS[command.needs](context),
  }));
}
