// @vitest-environment happy-dom
// G5: onboarding starts with a plain team; "Pre-load a saved team" is the one way to choose Ash's. It asks what the
// team should call you, and never says "Ash" on a fresh install.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../model/hubTeam", () => ({ preloadAshTeam: vi.fn(async () => []) }));
import { preloadAshTeam } from "../model/hubTeam";
import { HubOnboarding } from "./HubOnboarding";
import { storedUserName } from "../model/userName";

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
function typeName(value: string) {
  const input = container.querySelector("[data-hub-onboarding-name]") as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function finish(pick?: string, name?: string) {
  act(() => root.render(createElement(HubOnboarding, { onClose: () => undefined })));
  expect(container.textContent).toContain("What should your team call you?");
  if (name) typeName(name);
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  expect(container.textContent).not.toMatch(/\bAsh\b/);
  if (pick) act(() => button(pick).click());
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  act(() => (container.querySelector("[data-hub-onboarding-done]") as HTMLElement).click());
}

it("a plain team is picked to start with, and finishing pre-loads nothing; a skipped name stores none", () => {
  finish();
  expect(preloadAshTeam).not.toHaveBeenCalled();
  expect(storedUserName()).toBe("");
});

it("Pre-load a saved team is a choice, and finishing with it pre-loads Ash's team", () => {
  finish("Pre-load a saved team");
  expect(preloadAshTeam).toHaveBeenCalledTimes(1);
});

it("the name typed is what the team calls you", () => {
  finish(undefined, " Sam ");
  expect(storedUserName()).toBe("Sam");
});
