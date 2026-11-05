// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultArrangement, hideSection, pinPanel } from "../model/arrangement";
import type { HomeLine } from "../model/lines";
import { HomeScreen } from "./HomeScreen";

const line = (over: Partial<HomeLine>): HomeLine => ({
  id: "n1",
  kind: "decision",
  text: "Crew · Should we ship?",
  projectId: "crew",
  target: "ship",
  at: 1,
  ...over,
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(props: Partial<Parameters<typeof HomeScreen>[0]> = {}) {
  const onOpen = props.onOpen ?? (() => undefined);
  act(() => {
    root.render(createElement(HomeScreen, {
      needsYou: [],
      moving: [],
      recent: [],
      arrangement: defaultArrangement(),
      projects: [{ id: "crew", name: "Crew" }],
      catalog: [],
      known: true,
      failed: false,
      onOpen,
      onMove: () => undefined,
      onHide: () => undefined,
      onShow: () => undefined,
      onPin: () => undefined,
      onUnpin: () => undefined,
      onStart: () => undefined,
      renderPanel: () => createElement("p", null, "Example board"),
      ...props,
    }));
  });
}

it("hides an empty section, says all quiet, and offers a chat", () => {
  draw();
  expect(container.querySelector("[data-home-section]")).toBeNull();
  expect(container.querySelector("[data-home-empty]")?.textContent).toContain("All quiet.");
  expect(container.textContent).toContain("Start a chat with Crew");
  expect(container.querySelector("[data-count]")).toBeNull();
  expect(container.textContent).not.toMatch(/\d/);
});

it("shows a section that has a line and hides one that does not", () => {
  draw({
    needsYou: [line({})],
    moving: [line({ id: "m1", kind: "moving", text: "Crew · Write the notes · Ada" })],
  });
  expect(container.querySelector("[data-home-section='needs-you']")).not.toBeNull();
  expect(container.querySelector("[data-home-section='moving-now']")).not.toBeNull();
  expect(container.querySelector("[data-home-section='recent']")).toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  expect(container.querySelector("[data-home-start]")).toBeNull();
});

it("does not say all quiet before the first load, including when the load failed", () => {
  draw({ known: false, failed: false });
  expect(container.querySelector("[data-home-loading]")).not.toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  draw({ known: false, failed: true });
  expect(container.querySelector("[data-home-retry]")?.textContent).toContain("Couldn't load home. Trying again.");
  expect(container.querySelector("[data-home-empty]")).toBeNull();
});

it("keeps a hidden section hidden and still lists a pinned panel that is not in the catalog", () => {
  const arrangement = pinPanel(hideSection(defaultArrangement(), "needs-you"), "my-panels", "missing");
  draw({
    needsYou: [line({})],
    arrangement,
    catalog: [{ plugin: "my-panels", panelId: "board", title: "Example board", spec: { kind: "bespoke", title: "Example board", html: "<p>Example</p>", permissions: [] } }],
  });
  expect(container.querySelector("[data-home-section='needs-you']")).toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  expect(container.textContent).toContain("Show Needs you");
  expect(container.querySelector("[data-home-section='panel:my-panels:missing']")?.textContent).toContain("This panel is not available.");
  expect(container.textContent).toContain("Pin Example board");
});
