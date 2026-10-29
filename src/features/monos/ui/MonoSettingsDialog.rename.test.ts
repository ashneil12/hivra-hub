// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const saveMonoName = vi.fn();
vi.mock("../model/mono", async (original) => ({
  ...(await original<object>()),
  findMono: () => ({ id: "mono-1", name: "Chief of Staff", mascot: "cat", color: "#9c9", projects: [] }),
  saveMonoName: (...args: unknown[]) => saveMonoName(...args),
}));
vi.mock("../../sessions/ui/ModelPicker", () => ({ ModelPicker: () => null, ModelSettingRows: () => null }));
vi.mock("../model/monoFiles", async (original) => ({
  ...(await original<object>()),
  loadMonoFiles: async () => ({ id: "mono-1", dir: "/d", soul: "# Soul", soulHash: "s", memory: "", memoryHash: "m", memoryPath: "/d/MEMORY.md", topics: [] }),
}));

const { MonoSettingsDialog, NAME_SETTLE_MS } = await import("./MonoSettingsDialog");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  saveMonoName.mockReset();
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  vi.useRealTimers();
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      createElement(MonoSettingsDialog, {
        monoId: "mono-1",
        agent: { name: "Chief of Staff", mascot: "cat", color: "#9c9", projects: [] },
        status: "idle",
        cwd: "/home",
        harness: "codex",
        model: "codex:gpt-5.4",
        modelSettings: {},
        runtimeMode: "auto",
        busy: false,
        onModelChange: vi.fn(),
        onModelSettingsChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onClose: vi.fn(),
      } as never),
    ),
  );
}

/** Set the field's value the way accessibility does: no focus, no keys, one input event. */
function setValueWithoutTyping(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// r62 (A3): Alfred set the Name to "Boss" through accessibility; the field showed it, closing the dialog didn't save it.
it("saves a name set without typing once it settles", async () => {
  vi.useFakeTimers();
  await render();
  setValueWithoutTyping("Boss");
  expect(saveMonoName).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(NAME_SETTLE_MS));
  expect(saveMonoName).toHaveBeenCalledWith("mono-1", "Boss");
  act(() => root.unmount());
});

it("keeps a name set without typing when the dialog closes straight away", async () => {
  await render();
  setValueWithoutTyping("Boss");
  act(() => root.unmount());
  expect(saveMonoName).toHaveBeenCalledWith("mono-1", "Boss");
});

it("saves nothing when the name didn't change", async () => {
  vi.useFakeTimers();
  await render();
  act(() => vi.advanceTimersByTime(NAME_SETTLE_MS * 2));
  act(() => root.unmount());
  expect(saveMonoName).not.toHaveBeenCalled();
});

it("keeps a value set on the element with no event at all when the dialog closes", async () => {
  await render();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Boss");
  act(() => root.unmount());
  expect(saveMonoName).toHaveBeenCalledWith("mono-1", "Boss");
});
