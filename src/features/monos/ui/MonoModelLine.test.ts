// @vitest-environment happy-dom
// Port map idea 2: the model as small text above the box. A click moves to the next model and says so for 7 s
// (UniiChat Pick.ts move, main.ts toast); the chevron (our addition) opens the menu; on the Grok bridge it reads Grok 4.7.
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
const bridge = vi.hoisted(() => ({ on: false }));
vi.mock("../../../integrations/harness/providers/claude/claudeGrokBridge", () => ({
  claudeRunsOnGrok: () => bridge.on,
  onGrokBridge: (harness: string | undefined) => harness === "claude" && bridge.on,
  GROK_BRIDGE_LABEL: "Grok 4.7",
  claudePillName: (name: string, onGrok: boolean) => (onGrok ? "Grok 4.7" : name.replace(/^Claude /, "")),
}));

import { MODEL_NOTE_MS, MonoModelLine } from "./MonoModelLine";
import { resetHarnessModelOverlays } from "../../sessions/model/models";

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  localStorage.clear();
  resetHarnessModelOverlays();
  bridge.on = false;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = (harness: "grok" | "claude", model: string, onChange = vi.fn()) => {
  act(() => root.render(createElement(MonoModelLine, { harness, model, values: {}, onChange, onSettingsChange: vi.fn() })));
  return onChange;
};
const name = () => el.querySelector<HTMLButtonElement>("[data-mono-model-line] button[aria-haspopup]")!;

it("a click moves to the next model and says 'Now <model>.' for 7 s, then it goes", () => {
  expect(MODEL_NOTE_MS).toBe(7000);
  const onChange = render("grok", "grok:grok-4.6");
  act(() => name().click());
  expect(onChange).toHaveBeenCalledTimes(1);
  const [harness, next] = onChange.mock.calls[0] as [string, string];
  expect(harness).toBe("grok");
  expect(next).not.toBe("grok:grok-4.6");
  const note = () => el.querySelector("[data-mono-model-note]")?.textContent;
  expect(note()).toMatch(/^Now Grok .+\.$/);
  act(() => vi.advanceTimersByTime(MODEL_NOTE_MS - 1));
  expect(note()).toMatch(/^Now /);
  act(() => vi.advanceTimersByTime(1));
  expect(note()).toBeUndefined();
  // The menu stays shut: a click only moves on.
  expect(name().getAttribute("aria-expanded")).toBe("false");
});

it("the chevron opens the whole menu and changes nothing", () => {
  const onChange = render("grok", "grok:grok-4.6");
  const chevron = el.querySelector<HTMLButtonElement>("[data-model-menu]")!;
  expect(chevron.getAttribute("aria-label")).toBe("Choose a model");
  act(() => chevron.click());
  expect(chevron.getAttribute("aria-expanded")).toBe("true");
  expect(onChange).not.toHaveBeenCalled();
});

it("on the Grok bridge it reads Grok 4.7, and a click opens the menu instead of stepping through Claude names", () => {
  bridge.on = true;
  const onChange = render("claude", "claude:sonnet");
  expect(name().textContent).toContain("Grok 4.7");
  expect(el.querySelector("[data-model-menu]")).not.toBeNull();
  act(() => name().click());
  expect(onChange).not.toHaveBeenCalled();
  expect(name().getAttribute("aria-expanded")).toBe("true");
});
