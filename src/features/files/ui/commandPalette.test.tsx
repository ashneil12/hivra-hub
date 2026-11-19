// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../model/fileIndex", () => ({
  loadProjectFiles: vi.fn(() => new Promise(() => {})),
  peekProjectFiles: vi.fn(() => []),
  rankProjectFiles: vi.fn(() => []),
  recentOpenedFiles: vi.fn(() => []),
  rememberOpenedFile: vi.fn(),
}));

vi.mock("../../projects/model/recents", () => ({
  looksLikeProject: (path: string) => path !== "~",
}));

import { FilePicker } from "./FilePicker";
import { loadPaletteState, savePaletteState } from "../../search/model/paletteRanking";
import type { PaletteContext } from "../../search/model/commandRegistry";

const open: PaletteContext = {
  project: "/repo",
  terminal: true,
  chat: true,
  busy: true,
  terminalFocus: false,
  pickerFocus: false,
  editor: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A command runs once the palette has closed, a tick after the pick. */
function afterClose() {
  act(() => {
    vi.runOnlyPendingTimers();
  });
}

function renderPalette(options: {
  query?: string;
  context?: PaletteContext;
} = {}) {
  const onRunCommand = vi.fn();
  const onClose = vi.fn();
  act(() =>
    root.render(
      createElement(FilePicker, {
        open: true,
        cwd: "/repo",
        initialQuery: `> ${options.query ?? ""}`,
        onOpenFile: vi.fn(),
        onRunAction: vi.fn(),
        onRunCommand,
        paletteContext: options.context ?? open,
        onClose,
      }),
    ),
  );
  return { onRunCommand, onClose };
}

function input() {
  return document.querySelector<HTMLInputElement>("[data-file-picker] input")!;
}

function type(value: string) {
  const field = input();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: string) {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

function options() {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

function option(label: string) {
  const found = options().find(
    (entry) => entry.getAttribute("data-command-label") === label,
  );
  if (!found) throw new Error(`no option ${label}`);
  return found;
}

describe("the command palette", () => {
  it("lists every command in groups on an empty query, with shortcut hints", () => {
    renderPalette();
    const dialog = document.querySelector<HTMLElement>("[data-file-picker]")!;
    expect(dialog.getAttribute("aria-label")).toBe("Command Palette");
    expect(
      dialog.querySelector('[role="listbox"][aria-label="Commands"]'),
    ).not.toBeNull();
    const headings = [
      ...dialog.querySelectorAll<HTMLElement>("[data-command-group]"),
    ].map((node) => node.textContent);
    expect(headings).toEqual(expect.arrayContaining(["App", "Tab", "Git"]));
    expect(options().length).toBeGreaterThan(30);
    expect(option("Reload").querySelector("kbd")?.textContent).toBeTruthy();
    // A command with no shortcut of its own shows no chord.
    expect(option("New chat").querySelector("kbd")).toBeNull();
  });

  it("shows the current shortcut, and nothing when that shortcut is turned off", () => {
    localStorage.setItem(
      "monocode.keybindingOverrides",
      JSON.stringify({ "Tab: New": { disabled: true } }),
    );
    renderPalette();
    expect(option("New tab").querySelector("kbd")).toBeNull();
    expect(option("Close all tabs").querySelector("kbd")?.textContent).toBeTruthy();
  });

  it("filters as the person types and runs the chosen command through onRunCommand", () => {
    const { onRunCommand, onClose } = renderPalette();
    type("> new chat");
    const newChat = option("New chat");
    act(() => newChat.click());
    afterClose();
    expect(onRunCommand).toHaveBeenCalledTimes(1);
    expect(onRunCommand.mock.calls[0]?.[0]).toMatchObject({
      id: "app.new-chat",
      run: { kind: "app", action: "new-chat" },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs on Enter and remembers the pick for that query", () => {
    const { onRunCommand } = renderPalette();
    type("> setting");
    press("Enter");
    afterClose();
    expect(onRunCommand).toHaveBeenCalledTimes(1);
    expect(loadPaletteState().picks[0]).toMatchObject({
      query: "setting",
      id: "App: Settings",
    });

    act(() => root.unmount());
    root = createRoot(container);
    renderPalette({ query: "setting" });
    expect(options()[0]?.getAttribute("data-command-label")).toBe("Settings");
  });

  it("shows the last commands used first on an empty query", () => {
    const day = 24 * 60 * 60 * 1000;
    savePaletteState({
      uses: [
        { id: "App: Settings", at: Date.now() - day, count: 3 },
        { id: "App: Go to File", at: Date.now() - 2 * day, count: 1 },
      ],
      picks: [],
    });
    renderPalette();
    const headings = [
      ...document.querySelectorAll<HTMLElement>("[data-command-group]"),
    ].map((node) => node.textContent);
    expect(headings[0]).toBe("Recent");
    expect(options()[0]?.getAttribute("data-command-label")).toBe("Settings");
    expect(options()[1]?.getAttribute("data-command-label")).toBe("Go to File");
  });

  it("greys a command that cannot run, says why, and running it does nothing", () => {
    const { onRunCommand, onClose } = renderPalette({
      context: { ...open, project: null, chat: false, busy: false },
    });
    type("> new terminal");
    expect(option("New terminal").getAttribute("aria-disabled")).toBe("true");
    expect(option("New terminal").textContent).toContain("Open a project first");
    act(() => option("New terminal").click());
    expect(onRunCommand).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    type("> stop");
    expect(option("Stop chat").getAttribute("aria-disabled")).toBe("true");
    expect(option("Stop chat").textContent).toContain("Open a chat first");

    type("> reload");
    expect(option("Reload").getAttribute("aria-disabled")).toBeNull();
    act(() => option("Reload").click());
    afterClose();
    expect(onRunCommand).toHaveBeenCalledTimes(1);
    expect(onRunCommand.mock.calls[0]?.[0]).toMatchObject({
      id: "View: Reload",
      run: { kind: "app", action: "reload" },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says a remote project has no terminal to open here", () => {
    renderPalette({ context: { ...open, project: "remote://env/home/me/repo", terminal: false } });
    type("> new terminal");
    expect(option("New terminal").getAttribute("aria-disabled")).toBe("true");
    expect(option("New terminal").textContent).toContain(
      "This project has no folder on this computer",
    );
  });

  it("moves over runnable rows only, so Enter never lands on a greyed one", () => {
    const { onRunCommand } = renderPalette({
      context: { ...open, project: null },
    });
    type("> terminal");
    press("Enter");
    expect(onRunCommand).not.toHaveBeenCalled();
    expect(document.querySelector("[data-file-picker]")).not.toBeNull();
  });

  it("closes on Escape and says so when nothing matches", () => {
    const { onClose } = renderPalette();
    type("> zzzz");
    expect(document.body.textContent).toContain("No matching commands");
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes itself before running the command, and remembers the use", () => {
    const order: string[] = [];
    act(() =>
      root.render(
        createElement(FilePicker, {
          open: true,
          cwd: "/repo",
          initialQuery: "> reload",
          onOpenFile: vi.fn(),
          onRunAction: vi.fn(),
          onRunCommand: () => order.push("run"),
          paletteContext: open,
          onClose: () => order.push("close"),
        }),
      ),
    );
    press("Enter");
    expect(order).toEqual(["close"]);
    afterClose();
    expect(order).toEqual(["close", "run"]);
    expect(loadPaletteState().uses[0]?.id).toBe("View: Reload");
  });

  it("adds to the history as another window left it, not as this one saw it", () => {
    renderPalette({ query: "reload" });
    // Another window wrote a use and a pick after this palette loaded.
    savePaletteState({
      uses: [{ id: "App: Settings", at: Date.now(), count: 2 }],
      picks: [{ query: "sett", id: "App: Settings", at: Date.now() }],
    });
    press("Enter");
    const state = loadPaletteState();
    expect(state.uses.map((use) => use.id)).toEqual(["View: Reload", "App: Settings"]);
    expect(state.picks.map((pick) => pick.query)).toEqual(["reload", "sett"]);
  });

  it("never throws on a palette with no context", () => {
    renderPalette({ context: undefined as unknown as PaletteContext });
    expect(options().length).toBeGreaterThan(30);
  });
});
