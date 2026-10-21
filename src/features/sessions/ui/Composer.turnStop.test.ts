// @vitest-environment happy-dom
// Port map idea 2 in a coding team's own chat: the full Composer with `turnStop` and `modelLine` keeps the Mono chat's
// rule (TurnStop.tsx): Stop only while a turn runs and the box is empty; grey square in the send spot; Enter on the empty
// box stops; typing brings Send back; the model sits above the box instead of in the toolbar.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

const render = async (props: Record<string, unknown>) =>
  act(async () =>
    root.render(
      createElement(Composer, {
        focused: false,
        harness: "claude",
        model: "claude:sonnet",
        runtimeMode: "supervised",
        executionCwd: "~",
        hideTopBar: true,
        onFocus: vi.fn(),
        onCwdChange: vi.fn(),
        onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onSubmit: vi.fn(),
        ...props,
      }),
    ),
  );
const action = () => el.querySelector<HTMLButtonElement>('[aria-label="Stop"], [aria-label="Send"]')!;
const textarea = () => el.querySelector("textarea")!;
const type = async (text: string) =>
  act(async () => {
    textarea().value = text;
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
const enter = async () =>
  act(async () => {
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });

it("during a turn the empty box's send is the grey Stop, and a click or Enter stops the turn, never submits", async () => {
  const onStop = vi.fn();
  const onSubmit = vi.fn();
  await render({ busy: true, turnStop: true, onStop, onSubmit });
  const stop = action();
  expect(stop.getAttribute("aria-label")).toBe("Stop");
  expect(stop.hasAttribute("data-mono-stop")).toBe(true);
  expect(stop.className).toContain("size-6.5");
  expect(stop.className).toContain("bg-content/12");
  expect(stop.className).not.toMatch(/bg-white|red/);
  await act(async () => stop.click());
  await enter();
  expect(onStop).toHaveBeenCalledTimes(2);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("typing during the turn brings Send back; idle there is no Stop and Enter on an empty box stops nothing", async () => {
  const onStop = vi.fn();
  await render({ busy: true, turnStop: true, onStop });
  await type("one more thing");
  expect(action().getAttribute("aria-label")).toBe("Send");
  await type("");
  expect(action().getAttribute("aria-label")).toBe("Stop");
  await render({ busy: false, turnStop: true, onStop });
  expect(action().getAttribute("aria-label")).toBe("Send");
  await enter();
  expect(onStop).not.toHaveBeenCalled();
});

it("without turnStop the chat keeps the upstream Stop (white), so only coding-team chats change", async () => {
  await render({ busy: true, onStop: vi.fn() });
  expect(action().getAttribute("aria-label")).toBe("Stop");
  expect(action().hasAttribute("data-mono-stop")).toBe(false);
});

it("the model line sits above the box and replaces the toolbar's model picker", async () => {
  await render({ turnStop: true, modelLine: createElement("span", { "data-test-model": "" }, "Grok 4.7") });
  const line = el.querySelector("[data-mono-pick]")!;
  expect(line.textContent).toBe("Grok 4.7");
  expect(line.compareDocumentPosition(el.querySelector("[data-composer-box]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(el.querySelector("[data-composer-box] button[aria-haspopup]")?.getAttribute("aria-label") ?? "").not.toMatch(/Claude|Sonnet/);
  await render({ turnStop: false });
  expect(el.querySelector("[data-mono-pick]")).toBeNull();
});
