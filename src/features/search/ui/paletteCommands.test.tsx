// @vitest-environment happy-dom
// WP-93 fix: the palette's commands behave like their shortcuts. This mounts the
// real palette, the real registry and wiring, and the real model picker, and
// proves a command works from where the person was.
import { act, createElement, useState, type ReactNode, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../integrations/harness/core/availability", () => ({
  getHarnessAvailabilitySnapshot: () => 0,
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => Promise.resolve(),
  subscribeHarnessAvailability: () => () => undefined,
}));
vi.mock("../../../integrations/harness/core/registry", () => ({
  refreshHarnessCatalogs: () => Promise.resolve(),
}));
vi.mock("../../../shared/ui/Popover", () => ({
  Popover: ({ children, role, className, tabIndex, onKeyDown, style }: {
    children: ReactNode;
    role?: string;
    className?: string;
    tabIndex?: number;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    style?: CSSProperties;
  }) => createElement("div", { role, className, tabIndex, onKeyDown, style }, children),
}));
vi.mock("../../files/model/fileIndex", () => ({
  loadProjectFiles: vi.fn(() => new Promise(() => {})),
  peekProjectFiles: vi.fn(() => []),
  rankProjectFiles: vi.fn(() => []),
  recentOpenedFiles: vi.fn(() => []),
  rememberOpenedFile: vi.fn(),
}));
vi.mock("../../projects/model/recents", () => ({
  looksLikeProject: () => true,
}));

import { FilePicker } from "../../files/ui/FilePicker";
import { ModelPicker } from "../../sessions/ui/ModelPicker";
import { resetHarnessModelOverlays } from "../../sessions/model/models";
import {
  resolvePaletteRows,
  type PaletteContext,
  type PaletteRow,
} from "../model/commandRegistry";
import { focusBeforePalette, paletteFocusOf } from "../model/paletteFocus";
import { runPaletteCommand, type PaletteActions } from "../model/paletteWiring";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  localStorage.clear();
  resetHarnessModelOverlays();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  act(() => root.unmount());
  resetHarnessModelOverlays();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const base: PaletteContext = {
  project: "/repo",
  terminal: true,
  chat: true,
  busy: true,
  terminalFocus: false,
  pickerFocus: false,
  editor: false,
};

// The way App wires it: remember focus as the palette opens, judge it then.
function Host({ onStop }: { onStop: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [focusFrom, setFocusFrom] = useState<Element | null>(null);
  const context: PaletteContext = { ...base, ...paletteFocusOf(focusFrom) };
  const run = (row: PaletteRow) =>
    runPaletteCommand(row, {} as PaletteActions, {
      run: (_name, fn) => fn(),
      stopChat: () => "chat-1",
      stop: onStop,
      archiveFocused: () => undefined,
      showHome: () => undefined,
      showChanges: () => undefined,
      openModelPicker: () => window.dispatchEvent(new Event("open_model_picker")),
      newWindow: () => undefined,
      zoom: () => undefined,
      editor: () => undefined,
      forkChat: () => undefined,
      reportProblem: () => undefined,
      computerUseChat: () => undefined,
    });
  return createElement(
    "div",
    null,
    createElement("textarea", { "data-composer": "", id: "composer" }),
    createElement("button", {
      id: "open-palette",
      onClick: () => {
        setFocusFrom(focusBeforePalette(document.activeElement));
        setOpen(true);
      },
    }),
    createElement(ModelPicker, {
      harness: "grok",
      model: "grok:grok-4.6",
      values: { effort: "high" },
      hotkeys: true,
      onChange: () => undefined,
      onSettingsChange: () => undefined,
    }),
    open
      ? createElement(FilePicker, {
          open: true,
          cwd: "/repo",
          initialQuery: "> ",
          onOpenFile: () => undefined,
          onRunAction: () => undefined,
          onRunCommand: run,
          paletteContext: context,
          onClose: () => setOpen(false),
        })
      : null,
  );
}

function openPaletteFromComposer(onStop = vi.fn()) {
  act(() => root.render(createElement(Host, { onStop })));
  const composer = container.querySelector<HTMLTextAreaElement>("#composer")!;
  act(() => composer.focus());
  act(() =>
    container.querySelector<HTMLButtonElement>("#open-palette")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    ),
  );
  // The palette's own input takes focus, as in the app.
  const input = document.querySelector<HTMLInputElement>("[data-file-picker] input")!;
  act(() => input.focus());
  return { input, onStop };
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pick(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (entry) => entry.getAttribute("data-command-label") === label,
  );
  if (!found) throw new Error(`no option ${label}`);
  return found;
}

describe("palette commands from where the person was", () => {
  it("opens the model picker from the palette", () => {
    const { input } = openPaletteFromComposer();
    type(input, "> switch model");
    const option = pick("Switch Model");
    expect(option.getAttribute("aria-disabled")).toBeNull();
    // The picker ignores a second hotkey inside 80 ms of the clock's start.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => option.click());
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(document.querySelector("[data-file-picker]")).toBeNull();
    expect(
      container.querySelector('button[aria-haspopup="menu"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("enables Stop chat when the composer had focus, and stops the chat", () => {
    const { input, onStop } = openPaletteFromComposer();
    type(input, "> stop");
    const option = pick("Stop chat");
    expect(option.getAttribute("aria-disabled")).toBeNull();
    act(() => option.click());
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(onStop).toHaveBeenCalledWith("chat-1");
  });

  it("still greys Stop chat when a terminal had focus, like Esc", () => {
    const terminal = document.createElement("div");
    terminal.className = "monocode-terminal";
    terminal.tabIndex = 0;
    document.body.append(terminal);
    terminal.focus();
    const rows = resolvePaletteRows({ ...base, ...paletteFocusOf(focusBeforePalette(terminal)) });
    terminal.remove();
    expect(rows.find((row) => row.id === "Session: Stop")?.blockedReason).toBe(
      "Click the chat first",
    );
  });
});
