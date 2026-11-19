// @vitest-environment happy-dom
// H7: the setup checks come before the welcome choices, cannot be skipped, and close without recording anything if the
// person says "Not now". r61: that "Not now" is remembered, so the card stays away on later launches.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finishOnboarding, needsOnboarding } from "../model/onboarding";
import { recordSetupFact, SETUP_FACT_IDS, setupCardSnoozed, setupProved } from "../model/setupProof";
import { HubOnboarding } from "./HubOnboarding";

// The card's own checks are covered in HubOnboardingSetup.test.ts; here only how the steps are wired.
vi.mock("./HubOnboardingSetup", async () => {
  const { createElement } = await import("react");
  return {
    HubOnboardingSetup: ({ onProvedChange }: { onProvedChange: (proved: boolean) => void }) =>
      createElement("button", { "data-test-setup-pass": "", onClick: () => onProvedChange(true) }, "pass"),
  };
});

let root: Root;
let container: HTMLElement;
let closed: number;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  closed = 0;
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

const proveAll = () => {
  for (const id of SETUP_FACT_IDS) recordSetupFact(id, "proved");
};
const render = () => act(() => root.render(createElement(HubOnboarding, { onClose: () => void (closed += 1) })));
const next = () => container.querySelector("[data-hub-onboarding-next]") as HTMLButtonElement;
const notNow = () => container.querySelector("[data-hub-onboarding-not-now]") as HTMLButtonElement;

describe("setup before the welcome choices", () => {
  it("opens on the checks, with no way past them until they pass", () => {
    render();
    expect(container.querySelector("[data-hub-onboarding]")!.getAttribute("data-step")).toBe("setup");
    expect(container.textContent).toContain("Step 1 of 7");
    expect(container.querySelector("[data-hub-onboarding-skip]")).toBeNull();
    expect(container.querySelector("[data-hub-onboarding-name]")).toBeNull();
    expect(next().disabled).toBe(true);
    act(() => (container.querySelector("[data-test-setup-pass]") as HTMLButtonElement).click());
    expect(next().disabled).toBe(false);
    act(() => next().click());
    expect(container.querySelector("[data-hub-onboarding]")!.getAttribute("data-step")).toBe("welcome");
    expect(container.textContent).toContain("Step 2 of 7");
  });

  it("'Not now' closes without finishing onboarding or proving anything, and is remembered (r61)", () => {
    render();
    act(() => notNow().click());
    expect(closed).toBe(1);
    expect(needsOnboarding()).toBe(true);
    expect(setupProved()).toBe(false);
    expect(setupCardSnoozed()).toBe(true);
  });

  it("leaves a proved install with just the six welcome steps, even when opened on purpose", () => {
    finishOnboarding();
    proveAll();
    render();
    expect(container.querySelector("[data-hub-onboarding]")!.getAttribute("data-step")).toBe("welcome");
    expect(container.textContent).toContain("Step 1 of 6");
  });

  it("is the only step when the choices have been made but setup has not", () => {
    finishOnboarding();
    recordSetupFact("installed", "proved");
    render();
    expect(container.querySelector("[data-hub-onboarding]")!.getAttribute("data-step")).toBe("setup");
    expect(container.textContent).not.toContain("Step 1 of 1");
    act(() => (container.querySelector("[data-test-setup-pass]") as HTMLButtonElement).click());
    expect(next().textContent).toBe("Start using Hivra");
    act(() => next().click());
    expect(closed).toBe(1);
  });

  // r62 (Critiquito, 0.16.3): a card with only the setup step shows no "Step 1 of 1", and closing it once passed is
  // remembered like "Not now".
  it("drops the step count when setup is the only step, and remembers closing it", () => {
    finishOnboarding();
    render();
    expect(container.querySelector("[data-hub-onboarding]")!.getAttribute("data-step")).toBe("setup");
    expect(container.textContent).not.toMatch(/Step \d+ of \d+/);
    expect(container.querySelector("[data-hub-onboarding-count]")).toBeNull();
    act(() => (container.querySelector("[data-test-setup-pass]") as HTMLButtonElement).click());
    act(() => next().click());
    expect(closed).toBe(1);
    expect(setupCardSnoozed()).toBe(true);
  });
});

