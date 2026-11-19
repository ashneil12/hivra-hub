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
const stepNow = () => container.querySelector("[data-hub-onboarding]")?.getAttribute("data-step");
/** Continue until the card is on this step (one thing a step: welcome, start, team, tools, theme, done). */
function to(step: string) {
  for (let i = 0; i < 8 && stepNow() !== step; i += 1) act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  expect(stepNow()).toBe(step);
}
function finish(pick?: string, name?: string) {
  act(() => root.render(createElement(HubOnboarding, { onClose: () => undefined })));
  expect(container.textContent).toContain("What should your team call you?");
  if (name) typeName(name);
  to("start");
  expect(container.textContent).not.toMatch(/\bAsh\b/);
  expect(container.textContent).not.toMatch(/pre-load|saved team/i); // no pre-load offered
  to("team");
  expect(container.textContent).not.toMatch(/\bAsh\b|pre-load|saved team/i);
  if (pick) act(() => button(pick).click());
  to("done");
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

it("offers the starter Monos with only the Chief of Staff ticked, and adds only what stays ticked", () => {
  act(() => root.render(createElement(HubOnboarding, { onClose: () => undefined })));
  to("team");
  expect(container.querySelector("[data-hub-onboarding-team]")?.textContent).toContain("Chief of Staff is ticked to get you started. Only ticked ones are added.");
  const boxes = [...container.querySelectorAll("[data-hub-onboarding-starter]")];
  expect(boxes.map((box) => box.getAttribute("data-hub-onboarding-starter"))).toEqual([
    "coordinator", "design-review", "planner", "record-keeper", "team-steward",
  ]);
  // Ash, 11 Nov: the Chief of Staff starts ticked. The other four stay unticked (WP-05).
  expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", "false"]);
  act(() => root.unmount());
  root = createRoot(container);
  finish("Chief of Staff"); // unticked: nobody is added
  expect(listMonos()).toEqual([]);
});

it("a person who skips before seeing the list gets nobody", () => {
  act(() => root.render(createElement(HubOnboarding, { onClose: () => undefined })));
  act(() => (container.querySelector("[data-hub-onboarding-skip]") as HTMLElement).click());
  expect(listMonos()).toEqual([]);
});

it("the ticked Chief of Staff is an ordinary Mono, not the template id", () => {
  finish();
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
  to("start");
  const project = container.querySelector("[data-hub-onboarding-project]") as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(project, "Field notes");
    project.dispatchEvent(new Event("input", { bubbles: true }));
  });
  to("team");
  act(() => (container.querySelector("[data-hub-onboarding-group]") as HTMLElement).click());
  to("tools");
  act(() => (container.querySelector('[data-hub-onboarding-cli="codex"]') as HTMLElement).click());
  to("done");
  await act(async () => {
    (container.querySelector("[data-hub-onboarding-done]") as HTMLElement).click();
  });
  expect(closed).not.toHaveBeenCalled();
  expect(localStorage.getItem("monocode:hub-onboarded")).not.toBe("1");
  expect(storedUserName()).toBe("");
  // Back on the project step, with the name still there; the ticks on the later steps are kept too.
  expect(stepNow()).toBe("start");
  expect(container.querySelector("[data-hub-onboarding-error]")?.textContent).toMatch(/could not be made/i);
  expect((container.querySelector("[data-hub-onboarding-project]") as HTMLInputElement).value).toBe("Field notes");
  setHubDataSource(mockHubData);
  to("team");
  expect(container.querySelector("[data-hub-onboarding-group]")?.getAttribute("aria-checked")).toBe("true");
  to("tools");
  expect(container.querySelector('[data-hub-onboarding-cli="codex"]')?.getAttribute("aria-checked")).toBe("true");
  to("done");
  await act(async () => {
    (container.querySelector("[data-hub-onboarding-done]") as HTMLElement).click();
  });
  expect(closed).toHaveBeenCalled();
  expect(localStorage.getItem("monocode:hub-onboarded")).toBe("1");
  expect(storedUserName()).toBe("Sam");
});

// Ash, 11 Nov: onboarding "doesn't carry you through a proper setup flow". One thing a step, and none is required.
it("carries a person through one thing a step: the project, its first mates, the tools, and none is required", () => {
  act(() => root.render(createElement(HubOnboarding, { onClose: () => undefined })));
  expect(container.querySelector("[data-hub-onboarding-count]")?.textContent).toBe("Step 1 of 6");
  to("start");
  expect(container.querySelector("[data-hub-onboarding-count]")?.textContent).toBe("Step 2 of 6");
  expect(container.querySelector("[data-hub-onboarding-project]")).toBeTruthy();
  expect(container.querySelectorAll("[data-hub-onboarding-starter]")).toHaveLength(0);
  expect(container.querySelectorAll("[data-hub-onboarding-cli]")).toHaveLength(0);
  to("team");
  expect(container.querySelector("[data-hub-onboarding-count]")?.textContent).toBe("Step 3 of 6");
  expect(container.querySelectorAll("[data-hub-onboarding-starter]")).toHaveLength(5);
  expect(container.querySelector("[data-hub-onboarding-group]")?.getAttribute("aria-checked")).toBe("false");
  // Each one says what it does, in full, under its name.
  expect(container.querySelector('[data-hub-onboarding-starter="planner"]')?.textContent).toContain("Keeps the board: owner, state, evidence.");
  to("tools");
  expect(container.querySelector("[data-hub-onboarding-count]")?.textContent).toBe("Step 4 of 6");
  const clis = [...container.querySelectorAll("[data-hub-onboarding-cli]")];
  expect(clis.map((box) => box.getAttribute("data-hub-onboarding-cli"))).toContain("claude");
  // Dropwave: a setup that already proved Claude Code starts with it ticked; nothing else is, and it can be unticked.
  const tickedClis = clis.filter((box) => box.getAttribute("aria-checked") === "true").map((box) => box.getAttribute("data-hub-onboarding-cli"));
  expect(setupProved()).toBe(true);
  expect(tickedClis).toEqual(["claude"]);
  to("done");
  // The last step says back what was set up.
  const summary = container.querySelector("[data-hub-onboarding-summary]")?.textContent ?? "";
  expect(summary).toContain("First mates: Chief of Staff");
  expect(summary).toContain("Coding tools: Claude Code");
});

it("the first mates picked join the first project, so its list shows them; the Chief of Staff belongs to none", async () => {
  setHubDataSource(mockHubData);
  const closed = vi.fn();
  act(() => root.render(createElement(HubOnboarding, { onClose: closed })));
  to("start");
  const project = container.querySelector("[data-hub-onboarding-project]") as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(project, "Field notes");
    project.dispatchEvent(new Event("input", { bubbles: true }));
  });
  to("team");
  expect(container.querySelector("[data-hub-onboarding-team]")?.textContent).toContain("They join Field notes.");
  act(() => (container.querySelector('[data-hub-onboarding-starter="planner"]') as HTMLElement).click());
  to("done");
  expect(container.querySelector("[data-hub-onboarding-summary]")?.textContent).toContain("Project: Field notes");
  expect(container.querySelector("[data-hub-onboarding-summary]")?.textContent).toContain("First mates: Chief of Staff, Planner");
  await act(async () => {
    (container.querySelector("[data-hub-onboarding-done]") as HTMLElement).click();
  });
  expect(closed).toHaveBeenCalled();
  const added = listMonos();
  const planner = added.find((mono) => mono.name === "Planner");
  const chiefMono = added.find((mono) => mono.name === "Chief of Staff");
  expect(planner?.projects).toHaveLength(1);
  expect(planner?.projects[0]).toContain("field-notes");
  expect(chiefMono?.projects).toEqual([]);
});

it("a restore skips the first mates and the tools: the export brings them", () => {
  act(() => root.render(createElement(HubOnboarding, { onClose: () => undefined })));
  to("start");
  act(() => button("Restore from an export").click());
  expect(container.querySelector("[data-hub-onboarding-count]")?.textContent).toBe("Step 2 of 4");
  act(() => (container.querySelector("[data-hub-onboarding-next]") as HTMLElement).click());
  expect(stepNow()).toBe("theme");
});
