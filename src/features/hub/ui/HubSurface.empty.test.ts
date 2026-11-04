// @vitest-environment happy-dom
// WP-04: with no Ash OS, Today, Needs you and Being built show their empty states, never example data and never an
// outage. Needs, questions and checks wait for WP-14's decision store; Being built is the app's own delegations.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localTestHub } from "../../../dev/hubTestTransport";
import { setHubDataSource } from "../model/hubData";
import { HubStore } from "../model/hubStore";
import { createLiveHubData } from "../model/liveHubData";
import { BeingBuiltView } from "./BeingBuiltView";
import { HubSurface } from "./HubSurface";
import { ProjectStrip } from "./ProjectStrip";

const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let store: HubStore;
let root: Root;
let container: HTMLElement;

async function until(read: () => unknown, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!read()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${container.textContent}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}
const text = () => container.textContent ?? "";

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  store = new HubStore({ transport: (await localTestHub()).transport, ...FAST });
  setHubDataSource(createLiveHubData(store), store);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await new Promise((r) => setTimeout(r, 20));
  store.stop();
  setHubDataSource(undefined);
});

it("a project's Today: its own projects on the strip, Needs you empty, nothing being built, no example data, no outage", async () => {
  act(() =>
    root.render(
      createElement(
        "div",
        null,
        createElement(ProjectStrip, { selection: { project: "hivra", item: "inbox" }, onPickProject: () => undefined, onCreateProject: () => undefined }),
        createElement(HubSurface, { selection: { project: "hivra", item: "inbox" } }),
      ),
    ),
  );
  await until(() => container.querySelector('[data-hub-today-section="needs"]'), "Needs you");
  expect(container.querySelectorAll("[data-hub-need]")).toHaveLength(0);
  expect(container.querySelector("[data-hub-today-being-built]")).toBeNull();
  expect(text()).toContain("Hivra");
  expect(text()).not.toMatch(/Example:|isn't running|not connected/i);
});

it("Being built says quietly that nobody's working on anything", async () => {
  act(() => root.render(createElement(BeingBuiltView, { projectId: "hivra" })));
  await until(() => container.querySelector("[data-hub-being-built-empty]"), "empty");
  expect(text()).toContain("Nobody's working on");
});
