// @vitest-environment happy-dom
// G5: onboarding starts with a plain team; "Pre-load Ash's team" is the one way to choose his.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../model/hubTeam", () => ({ preloadAshTeam: vi.fn(async () => []) }));
import { preloadAshTeam } from "../model/hubTeam";
import { HubOnboarding } from "./HubOnboarding";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(preloadAshTeam).mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
function finish(pick?: string) {
  act(() => root.render(createElement(HubOnboarding, { onClose: () => undefined })));
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  if (pick) act(() => button(pick).click());
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  act(() => (container.querySelector("[data-hub-onboarding-done]") as HTMLElement).click());
}

it("a plain team is picked to start with, and finishing pre-loads nothing", () => {
  finish();
  expect(preloadAshTeam).not.toHaveBeenCalled();
});

it("Pre-load Ash's team is a choice, and finishing with it pre-loads his team", () => {
  finish("Pre-load Ash's team");
  expect(preloadAshTeam).toHaveBeenCalledTimes(1);
});
