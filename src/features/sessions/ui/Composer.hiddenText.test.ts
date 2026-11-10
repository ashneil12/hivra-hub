// @vitest-environment happy-dom
// WP-94: hidden characters (zero-width, bidi, the Unicode tag block) never reach the agent, and the composer says so.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function mount(onSubmit: (text: string) => void = vi.fn()) {
  act(() =>
    root.render(
      createElement(Composer, {
        focused: false,
        harness: "codex",
        model: "",
        runtimeMode: "supervised",
        executionCwd: "~",
        hideTopBar: true,
        onFocus: vi.fn(),
        onCwdChange: vi.fn(),
        onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onSubmit,
      }),
    ),
  );
  return container.querySelector("textarea")!;
}

async function type(field: HTMLTextAreaElement, text: string) {
  await act(async () => {
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(field: HTMLTextAreaElement) {
  await act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

const notice = () => container.querySelector("[data-composer-notice]")?.textContent ?? "";
const alert = () => container.querySelector('[role="alert"]')?.textContent ?? "";

it("strips hidden characters on send and says how many went", async () => {
  const onSubmit = vi.fn();
  const field = mount(onSubmit);
  await type(field, "Please review​ this‮ file.");
  await pressEnter(field);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit.mock.calls[0][0]).toBe("Please review this file.");
  expect(notice()).toBe("Removed 2 hidden characters from your message.");
});

it("says one character, not characters, and never sends a message of only hidden characters", async () => {
  const onSubmit = vi.fn();
  const field = mount(onSubmit);
  await type(field, "​");
  await pressEnter(field);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(alert()).toBe(
    "That message had only hidden characters, so it was not sent.",
  );
});

it("strips hidden characters pasted into the draft and never sends them", async () => {
  const onSubmit = vi.fn();
  const field = mount(onSubmit);
  const data = new DataTransfer();
  data.setData("text/plain", "a​b\u{e0041}");
  const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(paste, "clipboardData", { value: data });
  await act(async () => field.dispatchEvent(paste));
  expect(field.value).toBe("ab");
  expect(notice()).toBe("Removed 2 hidden characters from the paste.");
  await pressEnter(field);
  expect(onSubmit.mock.calls[0][0]).toBe("ab");
});

it("does not claim a removal for ordinary pasted text", async () => {
  const field = mount();
  const data = new DataTransfer();
  data.setData("text/plain", "plain words");
  const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(paste, "clipboardData", { value: data });
  await act(async () => field.dispatchEvent(paste));
  expect(notice()).toBe("");
  expect(alert()).toBe("");
});
