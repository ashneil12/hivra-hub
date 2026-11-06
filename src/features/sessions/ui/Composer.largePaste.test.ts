// @vitest-environment happy-dom
// WP-94: a paste of 32 KiB or more becomes a text-file attachment named by its first words, and Shift keeps it inline.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }),
}));

let container: HTMLDivElement;
let root: Root;
let submit: ReturnType<typeof vi.fn>;

function render(text = "") {
  act(() => {
    root.render(
      createElement(Composer, {
        focused: false,
        harness: "claude",
        model: "",
        runtimeMode: "supervised",
        executionCwd: "/repo",
        initialDraft: text,
        hideTopBar: true,
        onFocus: vi.fn(),
        onCwdChange: vi.fn(),
        onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onSubmit: submit,
      }),
    );
  });
  return container.querySelector("textarea")!;
}

/** A text paste, which carries no modifier keys: the shortcut is read from the keydown before it. */
function paste(target: HTMLTextAreaElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
      files: [],
      items: [],
    },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function settleUntil(check: () => boolean, what: string) {
  for (let waited = 0; waited < 3000; waited += 10) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (check()) return;
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

const chipCount = () =>
  container.querySelectorAll('[aria-label^="Remove "]').length;
const notice = () =>
  container.querySelector("[data-composer-notice]")?.textContent ?? "";
const alert = () => container.querySelector('[role="alert"]')?.textContent ?? "";

/** A write that reports whether the attachment landed, as the Rust side does. */
function mockWrite(outcome: (name: string) => Promise<string>) {
  invoke.mockImplementation(async (command: string, args: { name?: string }) => {
    if (command === "write_attachment") return outcome(args.name ?? "");
    return [];
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  submit = vi.fn();
  invoke.mockReset();
  mockWrite(async (name) => `/tmp/attachments/${name}`);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("turns a paste of 32 KiB or more into a text file instead of filling the draft", async () => {
  const text =
    "release notes for the build\nthe server port moved to 1430\n" +
    "and then a long tail of detail. ".repeat(1_200);
  const field = render();
  const event = paste(field, text);
  await settleUntil(() => chipCount() === 1, "the paste to become a file");

  expect(event.defaultPrevented).toBe(true);
  // The bytes are written unchanged, so nothing is lost by going through a file.
  expect(invoke).toHaveBeenCalledWith("write_attachment", {
    name: "release notes for the build.txt",
    data: expect.any(String),
  });
  expect(field.value).toBe("");
  expect(notice()).toBe(
    "That paste was large, so it became the file release notes for the build.txt. Hold Shift while pasting to keep it inline.",
  );
});

it("counts bytes, so a paste of 20,000 emoji is over the line", async () => {
  const field = render();
  paste(field, "🐙".repeat(20_000));
  await settleUntil(() => chipCount() === 1, "the emoji paste to become a file");
  expect(alert()).toBe("");
});

it("leaves a paste of 20,000 plain characters in the draft", async () => {
  const field = render();
  const text = "word ".repeat(4_000);
  const event = paste(field, text);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(event.defaultPrevented).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
  expect(chipCount()).toBe(0);
});

/** The keydown a person makes while pressing the shortcut; a paste event carries no modifiers. */
function shortcut(
  target: HTMLTextAreaElement,
  keys: { metaKey?: boolean; ctrlKey?: boolean; key?: string; code?: string },
) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: keys.key ?? "V",
        code: keys.code ?? "KeyV",
        metaKey: keys.metaKey ?? false,
        ctrlKey: keys.ctrlKey ?? false,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

it("keeps a large paste inline when Shift is held", async () => {
  const field = render();
  shortcut(field, { metaKey: true });
  const event = paste(field, "x".repeat(40 * 1024));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(event.defaultPrevented).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
  expect(chipCount()).toBe(0);
});

it("still pastes inline on a layout whose V key types another character", async () => {
  const field = render();
  // A Cyrillic layout reports "М" for the physical V key; e.code stays "KeyV".
  shortcut(field, { ctrlKey: true, key: "М" });
  const event = paste(field, "y".repeat(40 * 1024));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(event.defaultPrevented).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});

it("turns a large paste into a file when only V was pressed", async () => {
  const field = render();
  // Shift+V is just a capital letter: not the shortcut, so the paste becomes a file.
  act(() => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "V",
        code: "KeyV",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  paste(field, "w".repeat(40 * 1024));
  await settleUntil(() => chipCount() === 1, "the paste to become a file");
});

it("takes hidden characters out of the file it saves", async () => {
  const field = render();
  paste(field, "quarterly numbers ".repeat(2_000) + "​".repeat(40_000));
  await settleUntil(() => chipCount() === 1, "the paste to become a file");

  const [, args] = invoke.mock.calls.find(
    ([command]) => command === "write_attachment",
  ) as [string, { name: string; data: string }];
  const body = Buffer.from(args.data, "base64").toString("utf8");
  expect(body).not.toContain("​");
  expect(body).not.toContain("​");
  expect(body.startsWith("quarterly numbers quarterly numbers ")).toBe(true);
});

it("keeps the paste in the draft when it cannot be saved to a file", async () => {
  mockWrite(async () => {
    throw new Error("The disk is full.");
  });
  const field = render("keep ");
  const text = "z".repeat(40 * 1024);
  paste(field, text);
  await settleUntil(() => alert() !== "", "the failure to be reported");

  expect(alert()).toBe(
    "That paste was too big to send as text, and it could not be saved as a file. Try again.",
  );
  expect(chipCount()).toBe(0);
  // The text is not lost: it stays in the draft where the person can see it.
  expect(field.value).toBe(`keep ${text}`);
});
