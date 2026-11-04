// @vitest-environment happy-dom
// E7: a worker's line names the model it runs on, and Ash can change it right there — the chat says it runs on its own;
// it now also says on what. Without the model (an older surface) the line is exactly what it was.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../../integrations/harness/core/availability", () => ({
  getHarnessAvailabilitySnapshot: () => 0,
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => Promise.resolve(),
  subscribeHarnessAvailability: () => () => undefined,
}));
vi.mock("../../../integrations/harness/core/registry", () => ({ refreshHarnessCatalogs: () => Promise.resolve() }));

import { resetHarnessModelOverlays } from "../../sessions/model/models";
import { DelegatedChatNotice } from "./DelegationNotices";

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetHarnessModelOverlays();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

function render(props: Record<string, unknown> = {}) {
  const onJumpIn = vi.fn();
  const onModelChange = vi.fn();
  act(() =>
    root.render(
      createElement(DelegatedChatNotice, {
        ownerName: "EXO lead",
        state: "running",
        onJumpIn,
        ...props,
      }),
    ),
  );
  return { onJumpIn, onModelChange };
}

it("says which model the worker runs on, and lets Ash pick another from there", () => {
  const onJumpIn = vi.fn();
  const onModelChange = vi.fn();
  act(() =>
    root.render(
      createElement(DelegatedChatNotice, {
        ownerName: "EXO lead",
        state: "running",
        onJumpIn,
        modelHarness: "claude",
        model: "claude:sonnet-5",
        modelValues: {},
        onModelChange,
        onModelSettingsChange: vi.fn(),
      }),
    ),
  );
  const line = el.querySelector("[data-delegated-chat]")!;
  expect(line.textContent).toContain("Runs on its own");
  expect(el.querySelector("[data-delegated-model]")!.textContent).toContain("Sonnet 5");
  // The chevron still opens the whole menu; the name itself steps to the next model.
  expect(el.querySelector("[data-model-menu]")!.getAttribute("aria-label")).toBe("Choose a model");
  act(() => el.querySelector<HTMLButtonElement>("[data-mono-model-line] button[aria-haspopup]")!.click());
  expect(onModelChange).toHaveBeenCalledWith("claude", "claude:opus-5");
  // Jump in is still there, and still the right-hand action.
  const jump = el.querySelector<HTMLButtonElement>("[data-jump-in]")!;
  expect(jump.className).toContain("ml-auto");
  act(() => jump.click());
  expect(onJumpIn).toHaveBeenCalledTimes(1);
});

it("shows no model line when it isn't given one", () => {
  const { onJumpIn } = render();
  expect(el.querySelector("[data-delegated-model]")).toBeNull();
  expect(el.querySelector("[data-mono-model-line]")).toBeNull();
  expect(el.textContent).toContain("Runs on its own");
  act(() => el.querySelector<HTMLButtonElement>("[data-jump-in]")!.click());
  expect(onJumpIn).toHaveBeenCalledTimes(1);
});
