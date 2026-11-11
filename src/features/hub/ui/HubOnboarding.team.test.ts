// @vitest-environment happy-dom
// G5: onboarding asks what the team should call you, offers no pre-load (Ash 21 Oct: his team arrives by importing his
// export, like anyone's), and never says "Ash" on a fresh install.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { HubOnboarding } from "./HubOnboarding";
import { storedUserName } from "../model/userName";
import { recordSetupFact, SETUP_FACT_IDS, setupProved } from "../model/setupProof";
import { listMonos } from "../../monos/model/mono";
import { setHubDataSource } from "../model/hubData";
import { mockHubData } from "../model/mockData";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // H7 puts the setup checks first on an unproved install; these tests are about the welcome choices behind them.
  for (const id of SETUP_FACT_IDS) recordSetupFact(id, "proved");
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  setHubDataSource(undefined);
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
  expect(container.textContent).not.toMatch(/pre-load|saved team/i); // step 2: no pre-load offered
  if (pick) act(() => button(pick).click());
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  act(() => (container.querySelector("[data-hub-onboarding-done]") as HTMLElement).click());
}

it("offers no pre-load, and a skipped name stores none", () => {
  finish();
  expect(storedUserName()).toBe("");
});

it("the name typed is what the team calls you", () => {
  finish(undefined, " Sam ");
  expect(storedUserName()).toBe("Sam");
});

it("offers the starter Monos, none of them ticked, and adds none unless one is ticked", () => {
  act(() => root.render(createElement(HubOnboarding, { onClose: () => undefined })));
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  expect(container.querySelector("[data-hub-onboarding-team]")?.textContent).toContain("None are added unless you tick them");
  const boxes = [...container.querySelectorAll("[data-hub-onboarding-starter]")];
  expect(boxes.map((box) => box.getAttribute("data-hub-onboarding-starter"))).toEqual([
    "coordinator", "design-review", "planner", "record-keeper", "team-steward",
  ]);
  expect(boxes.every((box) => box.getAttribute("aria-checked") === "false")).toBe(true);
  act(() => root.unmount());
  root = createRoot(container);
  finish();
  expect(listMonos()).toEqual([]);
});

it("a ticked starter Mono is an ordinary Mono, not the template id", () => {
  finish("Chief of Staff");
  const added = listMonos();
  expect(added).toHaveLength(1);
  expect(added[0]?.name).toBe("Chief of Staff");
  expect(added[0]?.id).not.toBe("coordinator");
});

it("a project that cannot be made stays on the card, with what was entered", async () => {
  setHubDataSource(mockHubData, { getSnapshot: () => { throw new Error("timed out"); } } as never);
  const closed = vi.fn();
  act(() => root.render(createElement(HubOnboarding, { onClose: closed })));
  typeName("Sam");
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  act(() => (container.querySelector('[data-hub-onboarding-cli="codex"]') as HTMLElement).click());
  const project = container.querySelector("[data-hub-onboarding-project]") as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(project, "Field notes");
    project.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => (container.querySelector("[data-hub-onboarding-group]") as HTMLElement).click());
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  await act(async () => {
    (container.querySelector("[data-hub-onboarding-done]") as HTMLElement).click();
  });
  expect(closed).not.toHaveBeenCalled();
  expect(localStorage.getItem("monocode:hub-onboarded")).not.toBe("1");
  expect(storedUserName()).toBe("");
  expect(container.querySelector("[data-hub-onboarding-error]")?.textContent).toMatch(/could not be made/i);
  expect((container.querySelector("[data-hub-onboarding-project]") as HTMLInputElement).value).toBe("Field notes");
  expect(container.querySelector('[data-hub-onboarding-cli="codex"]')?.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector("[data-hub-onboarding-group]")?.getAttribute("aria-checked")).toBe("true");

  setHubDataSource(mockHubData);
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  await act(async () => {
    (container.querySelector("[data-hub-onboarding-done]") as HTMLElement).click();
  });
  expect(closed).toHaveBeenCalled();
  expect(localStorage.getItem("monocode:hub-onboarded")).toBe("1");
  expect(storedUserName()).toBe("Sam");
});

it("offers the CLIs, a project and a group on the same step, and none are required", () => {
  act(() => root.render(createElement(HubOnboarding, { onClose: () => undefined })));
  expect(container.querySelector("[data-hub-onboarding-count]")?.textContent).toBe("Step 1 of 4");
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  expect(container.querySelector("[data-hub-onboarding-count]")?.textContent).toBe("Step 2 of 4");
  const clis = [...container.querySelectorAll("[data-hub-onboarding-cli]")];
  expect(clis.map((box) => box.getAttribute("data-hub-onboarding-cli"))).toContain("claude");
  // Dropwave: a setup that already proved Claude Code starts with it ticked; nothing else is, and it can be unticked.
  const tickedClis = clis.filter((box) => box.getAttribute("aria-checked") === "true").map((box) => box.getAttribute("data-hub-onboarding-cli"));
  expect(setupProved()).toBe(true);
  expect(tickedClis).toEqual(["claude"]);
  expect(container.querySelector("[data-hub-onboarding-group]")?.getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector("[data-hub-onboarding-project]")).toBeTruthy();
  expect(container.querySelectorAll("[data-hub-onboarding-starter]")).toHaveLength(5);
});
