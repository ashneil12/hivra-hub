// @vitest-environment happy-dom
// WP-06: Today, Needs you and Being built are not screens. A stored inbox or being-built item does not draw them.
// The project strip and the no-project empty state stay, with no example data and no outage.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localTestHub } from "../../../dev/hubTestTransport";
import { setHubDataSource } from "../model/hubData";
import { HubStore } from "../model/hubStore";
import { createLiveHubData } from "../model/liveHubData";
import { HubSurface } from "./HubSurface";
import { ProjectStrip } from "./ProjectStrip";

const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let store: HubStore;
let root: Root;
let container: HTMLElement;

const text = () => container.textContent ?? "";
async function until(read: () => boolean) {
  for (let i = 0; i < 80 && !read(); i++) await act(async () => new Promise((r) => setTimeout(r, 15)));
  if (!read()) throw new Error("timed out waiting for the hub surface");
}

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

it("a stored Today or Being built item does not draw those screens", async () => {
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
  await until(() => text().includes("Hivra"));
  expect(container.querySelector('[data-hub-today-section="needs"]')).toBeNull();
  expect(container.querySelector("[data-hub-today-being-built]")).toBeNull();
  expect(container.querySelector("[data-hub-being-built]")).toBeNull();
  expect(container.querySelector("[data-hub-project-decisions]")).toBeNull();
  expect(text()).toContain("Hivra");
  expect(text()).not.toMatch(/Example:|isn't running|not connected/i);
});

it("says so when what it waits for never arrives", async () => {
  await expect(until(() => false)).rejects.toThrow(/timed out/);
});

it("a project with no code folder says so and does not open the coding team", async () => {
  const { hubData, setHubDataSource: setSource } = await import("../model/hubData");
  const src = Object.create(hubData());
  src.listProjects = () => [{ id: "notes", name: "Notes", shortName: "Notes", iconShape: "book", folder: null }];
  src.listProjectItems = () => [];
  src.connection = () => ({ status: "ready" });
  setSource(src);
  act(() => root.render(createElement(HubSurface, { selection: { project: "notes", item: "no-code" } })));
  expect(text()).toContain("This project has no code folder yet.");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(localStorage.getItem("monocode:hub-nav") ?? "").not.toContain("coding-team");
});

it("no project still offers a new one, and nothing from the old boards", () => {
  act(() => root.render(createElement(HubSurface, { selection: { project: "", item: "" } })));
  expect(container.querySelector("[data-hub-surface]")?.getAttribute("aria-label")).toBe("Projects");
  expect(container.querySelectorAll("[data-hub-today-section]").length).toBe(0);
  expect(text()).not.toMatch(/Example|Operator/);
});
