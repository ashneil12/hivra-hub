// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../../settings/model/settings";
import {
  PALETTE_COMMANDS,
  PALETTE_OMITTED,
  hasPaletteSpec,
  resolvePaletteRows,
  type PaletteContext,
} from "./commandRegistry";

const nowhere: PaletteContext = {
  project: null,
  terminal: false,
  chat: false,
  busy: false,
  terminalFocus: false,
  pickerFocus: false,
  editor: false,
};

const anywhere: PaletteContext = {
  project: "/work/this",
  terminal: true,
  chat: true,
  busy: true,
  terminalFocus: false,
  pickerFocus: false,
  editor: true,
};

beforeEach(() => {
  localStorage.clear();
});

function row(id: string, context: PaletteContext = anywhere) {
  const found = resolvePaletteRows(context).find((entry) => entry.id === id);
  if (!found) throw new Error(`missing palette command ${id}`);
  return found;
}

describe("the palette command registry", () => {
  it("turns every keybinding row into one command, with its group and label", () => {
    const ids = PALETTE_COMMANDS.map((command) => command.id);
    for (const binding of KEYBINDINGS) {
      if (binding.command in PALETTE_OMITTED) continue;
      expect(ids.filter((id) => id === binding.command)).toHaveLength(1);
      const command = PALETTE_COMMANDS.find((entry) => entry.id === binding.command)!;
      const [group] = binding.command.split(": ");
      expect(command.group).toBe(group);
      expect(command.label.trim().length).toBeGreaterThan(0);
      expect(command.keys).toBe(binding.keys);
    }
  });

  it("derives the same ids every time, and no id twice", () => {
    const ids = PALETTE_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(resolvePaletteRows(anywhere).map((entry) => entry.id)).toEqual(ids);
  });

  it("adds the commands that have no shortcut", () => {
    const ids = PALETTE_COMMANDS.map((command) => command.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "app.new-chat",
        "app.home",
        "app.inbox",
        "app.commit",
        "app.create-pr",
        "git.next-chat-worktree",
        "session.fork-from-here",
      ]),
    );
    expect(row("app.new-chat").label).toBe("New chat");
    expect(row("app.new-chat").hint).toBeNull();
    expect(row("app.commit").label).toBe("Commit");
    expect(row("app.create-pr").label).toBe("Create PR");
    expect(row("app.commit").group).toBe("Git");
    const next = row("git.next-chat-worktree", nowhere);
    expect(next.label).toBe("Next chat: use its own worktree");
    expect(next.group).toBe("Git");
    expect(next.needs).toBe("none");
    expect(next.blockedReason).toBeNull();
    expect(next.run).toEqual({ kind: "app", action: "next-chat-worktree" });
    expect(next.label).not.toMatch(/[—–]/);
    const fork = row("session.fork-from-here", nowhere);
    expect(fork.label).toBe("Fork from here");
    expect(fork.group).toBe("Session");
    expect(fork.needs).toBe("chat");
    expect(fork.blockedReason).toBe("Open a chat first");
    expect(fork.run).toEqual({ kind: "app", action: "fork-from-here" });
    expect(fork.label).not.toMatch(/[—–]/);
    expect(row("session.fork-from-here").blockedReason).toBeNull();
  });

  it("shows the person's current shortcut, and nothing when it is disabled", () => {
    localStorage.setItem(
      "monocode.keybindingOverrides",
      JSON.stringify({ "Tab: New": { disabled: true } }),
    );
    expect(row("Tab: New").binding).toBe("Tab: New");
    expect(row("Tab: New").hint).toBeNull();
    expect(row("Tab: Close All").hint).toBe(
      KEYBINDINGS.find((entry) => entry.command === "Tab: Close All")!.keys,
    );
    expect(row("app.new-chat").hint).toBeNull();
  });

  it("uses a rebound shortcut as the hint", () => {
    localStorage.setItem(
      "monocode.keybindingOverrides",
      JSON.stringify({ "Tab: New": { shortcut: "Control+Option+KeyT" } }),
    );
    expect(row("Tab: New").hint).toBe("Ctrl+Alt+T");
  });

  it("gives a plain one-line reason when a command cannot run, and none when it can", () => {
    expect(row("Session: Stop", nowhere).blockedReason).toBe("Open a chat first");
    expect(row("Session: Stop", { ...anywhere, busy: false }).blockedReason).toBe(
      "No chat is running right now",
    );
    expect(row("Session: Stop").blockedReason).toBeNull();
    expect(row("app.new-chat").blockedReason).toBeNull();
    expect(row("app.commit", nowhere).blockedReason).toBe("Open a project first");
    expect(row("Project: Next", nowhere).blockedReason).toBe("Open a project first");
    expect(row("Project: Next").blockedReason).toBeNull();
    expect(row("Editor: Find", nowhere).blockedReason).toBe(
      "Open a file in the editor first",
    );
    expect(row("Editor: Find").blockedReason).toBeNull();
    expect(row("Terminal: Toggle Dock", nowhere).blockedReason).toBe(
      "Open a project first",
    );
    expect(
      row("Terminal: Toggle Dock", { ...anywhere, terminal: false }).blockedReason,
    ).toBe("This project has no folder on this computer");
    expect(
      row("Terminal: New", { ...anywhere, terminal: false }).blockedReason,
    ).toBe("This project has no folder on this computer");
    expect(row("App: Switch Model", nowhere).blockedReason).toBe("Open a chat first");
    expect(
      row("App: Switch Model", { ...anywhere, pickerFocus: true }).blockedReason,
    ).toBe("Click the chat first");
    expect(
      row("App: Switch Model", { ...anywhere, terminalFocus: true }).blockedReason,
    ).toBe("Click the chat first");
    expect(
      row("Session: Stop", { ...anywhere, terminalFocus: true }).blockedReason,
    ).toBe("Click the chat first");
    // Esc stops a chat from the composer, and Switch model works from it too:
    // the composer is an input, which is not a reason to grey either out.
    expect(row("Session: Stop", { ...anywhere, pickerFocus: true }).blockedReason).toBeNull();
    expect(row("App: Settings", nowhere).blockedReason).toBeNull();
    expect(row("View: Reload", nowhere).blockedReason).toBeNull();
  });

  it("keeps every reason to one plain sentence", () => {
    for (const context of [nowhere, anywhere, { ...nowhere, chat: true }]) {
      for (const entry of resolvePaletteRows(context)) {
        if (entry.blockedReason === null) continue;
        expect(entry.blockedReason).not.toContain("\n");
        expect(entry.blockedReason).not.toContain("—");
        expect(entry.blockedReason).not.toContain("–");
        expect(entry.blockedReason.endsWith(".")).toBe(false);
        expect(entry.blockedReason.length).toBeLessThanOrEqual(48);
      }
    }
  });

  it("never shows the Quick Composer, which only the system shortcut opens", () => {
    for (const context of [nowhere, anywhere]) {
      const ids = resolvePaletteRows(context).map((entry) => entry.id);
      expect(ids).not.toContain("App: Quick Composer");
      expect(ids).not.toContain("Composer: Toggle Workspace");
    }
  });

  it("runs every command through the handler its shortcut already uses", () => {
    const run = (id: string) => row(id).run;
    expect(run("Tab: New")).toEqual({ kind: "tab", command: "new" });
    expect(run("Pane: Close")).toEqual({ kind: "tab", command: "close" });
    expect(run("Terminal: Toggle Dock")).toEqual({
      kind: "tab",
      command: "toggle-terminal",
    });
    expect(run("Tab: Activate Last")).toEqual({
      kind: "tab",
      command: { activate: -1 },
    });
    expect(run("App: Command Palette")).toEqual({
      kind: "app",
      action: "command-palette",
    });
    expect(run("View: Zoom In")).toEqual({ kind: "zoom", action: "zoom-in" });
    expect(run("Editor: Replace")).toEqual({
      kind: "editor",
      action: "replace",
    });
    expect(run("Tab: Activate 1–8")).toEqual({ kind: "none" });
    expect(run("app.commit")).toEqual({ kind: "app", action: "changes" });
  });

  it("never throws on a blank context", () => {
    expect(() => resolvePaletteRows(nowhere)).not.toThrow();
    expect(resolvePaletteRows(nowhere).length).toBeGreaterThan(20);
  });

  it("writes labels and reasons without em or en dashes", () => {
    for (const entry of resolvePaletteRows(anywhere)) {
      expect(entry.label).not.toContain("—");
      expect(entry.label).not.toContain("–");
    }
  });
});

describe("the shortcut table and the palette stay in step", () => {
  it("maps every shortcut row, or lists it as left out on purpose", () => {
    // A row that is neither would silently open Settings from the palette.
    const unmapped = KEYBINDINGS.map((row) => row.command).filter(
      (command) => !hasPaletteSpec(command) && !(command in PALETTE_OMITTED),
    );
    expect(unmapped).toEqual([]);
  });
});
