// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MonoComposer } from "./MonoComposer";
import { clearComposerDraft } from "../../sessions/model/draftCache";
import { saveComposerAutocorrect } from "../../settings/model/displayPrefs";

const { pick } = vi.hoisted(() => ({ pick: vi.fn() }));
vi.mock("../../sessions/model/attachments", async (original) => ({
  ...(await original<typeof import("../../sessions/model/attachments")>()),
  pickAttachments: pick,
}));
vi.mock("../../sessions/hooks/useFileDrop", () => ({
  useFileDrop: () => false,
}));
// The picker itself is covered on its own; here it just hands over a pick.
vi.mock("../../../shared/ui/EmojiPicker", async () => {
  const { createElement } = await import("react");
  return {
    EmojiPickerPopover: ({ onPick }: { onPick: (emoji: string) => void }) =>
      createElement(
        "button",
        { type: "button", "data-pick": "", onClick: () => onPick("😀") },
        "pick",
      ),
  };
});

let container: HTMLDivElement;
let root: Root;
const file = {
  id: "file",
  name: "note.txt",
  kind: "file" as const,
  mimeType: "text/plain",
  size: 12,
  path: "/tmp/note.txt",
};
/** + opens its menu; Files is the picker for any file. */
async function attachFile() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!
      .click(),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-attach-pick="file"]')!
      .click(),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  clearComposerDraft("chat");
  pick.mockReset().mockResolvedValue([file]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearComposerDraft("chat");
  vi.unstubAllGlobals();
});
function render(extra: Partial<Parameters<typeof MonoComposer>[0]> = {}) {
  act(() =>
    root.render(
      createElement(MonoComposer, {
        sessionId: "chat",
        name: "Captain",
        onSubmit: () => true,
        ...extra,
      }),
    ),
  );
}
function field() {
  return container.querySelector<HTMLTextAreaElement>(
    '[aria-label="Message Captain"]',
  )!;
}
function type(text: string) {
  const input = field();
  const props = Object.entries(input).find(([key]) =>
    key.startsWith("__reactProps"),
  )![1];
  act(() => props.onChange({ target: { value: text } }));
}
function submit() {
  container
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

it("consumes quotes once and adds them to the current draft", () => {
  const consumed = vi.fn();
  render();
  type("My question");
  const quoteRequest = { id: 1, text: "Selected answer" };
  render({ quoteRequest, onQuoteRequestConsumed: consumed });
  expect(field().value).toBe("My question\n\n> Selected answer\n\n");
  render({ quoteRequest, onQuoteRequestConsumed: consumed, enabled: false });
  expect(field().value.match(/Selected answer/g)).toHaveLength(1);
  expect(consumed).toHaveBeenCalledWith(1);
});

it("sends consecutive messages without duplicating rapid Enter presses", () => {
  const onSubmit = vi.fn(() => true);
  render({ onSubmit });
  type("First");
  act(() => {
    submit();
    submit();
  });
  type("Second");
  act(submit);
  expect(onSubmit.mock.calls).toEqual([
    ["First", []],
    ["Second", []],
  ]);
  expect(field().value).toBe("");
});

it("retains text and attachments if the message is rejected", async () => {
  const onSubmit = vi.fn(() => false);
  render({ onSubmit });
  type("Keep these");
  await attachFile();
  act(submit);
  expect(onSubmit).toHaveBeenCalledWith("Keep these", [file]);
  expect(field().value).toBe("Keep these");
  expect(container.querySelector('[title="/tmp/note.txt"]')).not.toBeNull();
});

it("waits for attachment reads so they cannot leak into the next message", async () => {
  let accept!: (files: (typeof file)[]) => void;
  pick.mockReturnValue(
    new Promise((resolve) => {
      accept = resolve;
    }),
  );
  const onSubmit = vi.fn(() => true);
  render({ onSubmit });
  type("With this file");
  await attachFile();
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled,
  ).toBe(true);
  act(submit);
  expect(onSubmit).not.toHaveBeenCalled();
  await act(async () => accept([file]));
  act(submit);
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("With this file", [file]);
  expect(container.querySelector('[title="/tmp/note.txt"]')).toBeNull();
});

it("waits for delivery and keeps a rejected message available to retry", async () => {
  let acknowledge!: (accepted: boolean) => void;
  const onSubmit = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        acknowledge = resolve;
      }),
  );
  render({ onSubmit });
  type("Keep this draft");
  act(() => {
    submit();
    submit();
  });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(field().value).toBe("Keep this draft");
  expect(field().disabled).toBe(true);
  await act(async () => {
    acknowledge(false);
  });
  expect(field().value).toBe("Keep this draft");
  expect(field().disabled).toBe(false);
  act(() => submit());
  await act(async () => {
    acknowledge(true);
  });
  expect(field().value).toBe("");
  expect(onSubmit).toHaveBeenCalledTimes(2);
});

it("follows the composer autocorrect setting", () => {
  render();
  expect(field().getAttribute("spellcheck")).toBe("true");
  expect(field().getAttribute("autocorrect")).toBe("on");

  act(() => saveComposerAutocorrect(false));
  expect(field().getAttribute("spellcheck")).toBe("false");
  expect(field().getAttribute("autocorrect")).toBe("off");

  act(() => saveComposerAutocorrect(true));
  expect(field().getAttribute("spellcheck")).toBe("true");
});

it("inserts a picked emoji where the cursor was, beside attach", async () => {
  render({ controls: createElement("span", null, "Model") });
  const field = container.querySelector("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(field, "hi there");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  field.setSelectionRange(2, 2);
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Add emoji"]',
  )!;
  expect(
    button.previousElementSibling
      ?.querySelector("button")
      ?.getAttribute("aria-label"),
  ).toBe("Attach files");
  // The picker loads on first open.
  await act(async () => button.click());
  await vi.waitFor(() =>
    expect(container.querySelector("[data-pick]")).not.toBeNull(),
  );
  expect(button.getAttribute("aria-expanded")).toBe("true");
  act(() => container.querySelector<HTMLButtonElement>("[data-pick]")!.click());
  expect(field.value).toBe("hi😀 there");
  expect(container.querySelector("[data-pick]")).toBeNull();

  // The floating chat keeps its inline input, without the extra row.
  render();
  expect(container.querySelector('button[aria-label="Add emoji"]')).toBeNull();
});

it("+ offers photos and videos or any file, and picks the kind asked for (Ash, 15 Oct: a variety of media)", async () => {
  render({ onSubmit: vi.fn(() => true), controls: createElement("span", null, "Model") });
  const plus = container.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!;
  expect(plus.getAttribute("aria-haspopup")).toBe("menu");
  await act(async () => plus.click());
  // Nothing is picked until Ash says what: the menu names both kinds and that pasting or dropping works too.
  expect(pick).not.toHaveBeenCalled();
  const menu = container.querySelector("[data-attach-menu]")!;
  expect(menu.textContent).toContain("Photo or image");
  expect(menu.textContent).toContain("File");
  expect(menu.textContent).toContain("paste or drop");
  await act(async () => container.querySelector<HTMLButtonElement>('[data-attach-pick="media"]')!.click());
  expect(pick).toHaveBeenLastCalledWith("media");
  expect(container.querySelector("[data-attach-menu]")).toBeNull();
  await act(async () => plus.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[data-attach-pick="file"]')!.click());
  expect(pick).toHaveBeenLastCalledWith("file");
  // Escape closes the menu without picking.
  await act(async () => plus.click());
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(container.querySelector("[data-attach-menu]")).toBeNull();
  expect(pick).toHaveBeenCalledTimes(2);
});

// Port map idea 2, after UniiChat main.ts bars(): `stop = on && v.busy && BOX.value.trim() === "" && P.imgs.length === 0`.
function enter() {
  act(() => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}
const sendSlot = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

it("send becomes Stop in the same spot and size only while a turn runs and the box is empty", () => {
  const onStop = vi.fn();
  render({ busy: false, onStop });
  expect(sendSlot().getAttribute("aria-label")).toBe("Send");
  const sendClass = sendSlot().className.match(/size-\S+/)?.[0];
  render({ busy: true, onStop });
  expect(sendSlot().getAttribute("aria-label")).toBe("Stop");
  expect(container.querySelectorAll('button[type="submit"]')).toHaveLength(1);
  expect(sendSlot().className).toContain(sendClass!);
  // Monochrome: a grey fill, never red.
  expect(sendSlot().className).toContain("bg-content/12");
  expect(sendSlot().className).not.toMatch(/red|amber|accent/);
});

it("typing while busy brings Send back, and the message goes in mid-turn", () => {
  const onStop = vi.fn();
  const onSubmit = vi.fn(() => true);
  render({ busy: true, onStop, onSubmit });
  type("one more thing");
  expect(sendSlot().getAttribute("aria-label")).toBe("Send");
  act(submit);
  expect(onSubmit).toHaveBeenCalledWith("one more thing", []);
  expect(onStop).not.toHaveBeenCalled();
});

it("a waiting attachment keeps Send while busy", async () => {
  render({ busy: true, onStop: vi.fn() });
  await attachFile();
  expect(sendSlot().getAttribute("aria-label")).toBe("Send");
});

it("Stop or Enter on the empty box stops the turn, and never submits", () => {
  const onStop = vi.fn();
  const onSubmit = vi.fn(() => true);
  render({ busy: true, onStop, onSubmit });
  act(() => sendSlot().click());
  enter();
  expect(onStop).toHaveBeenCalledTimes(2);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("idle, Enter on an empty box does nothing; without a stop handler there is no Stop", () => {
  const onStop = vi.fn();
  const onSubmit = vi.fn(() => true);
  render({ busy: false, onStop, onSubmit });
  enter();
  expect(onStop).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  render({ busy: true, onSubmit });
  expect(sendSlot().getAttribute("aria-label")).toBe("Send");
});

it("the model line sits above the box, not under it", () => {
  render({ modelLine: createElement("span", { "data-test-model": "" }, "Grok 4.7") });
  const line = container.querySelector("[data-mono-pick]")!;
  const box = container.querySelector(".agent-chat-composer")!;
  expect(line.textContent).toBe("Grok 4.7");
  expect(line.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
