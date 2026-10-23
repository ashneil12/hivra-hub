// @vitest-environment happy-dom
// G1: the hub has no central area. An old "Today for all projects" selection opens on no project — the create-a-project
// empty state, or the first project once there is one — and every way in names a project or one of the app's own views,
// never a board of all projects.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NO_PROJECT, setHubSelection, showAppItem, showProjectToday, useHubSelection, type HubSelection } from "./hubNav";

let root: Root;
let seen: HubSelection | undefined;

function Probe() {
  seen = useHubSelection();
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
});

it("an old 'today' selection opens on no project, so the hub shows a project or the empty state", () => {
  localStorage.setItem("monocode:hub-nav", JSON.stringify({ project: "today", item: "inbox" }));
  act(() => root.render(createElement(Probe)));
  expect(seen).toEqual({ project: NO_PROJECT, item: "" });
  // Reading it never writes a global Today back.
  expect(JSON.parse(localStorage.getItem("monocode:hub-nav")!).project).toBe("today");
});

it("every way in names a project or the app's own view", () => {
  act(() => root.render(createElement(Probe)));
  act(() => showProjectToday("hivra"));
  expect(seen).toEqual({ project: "hivra", item: "inbox" });
  // New project and Restore open over the project Ash was in, so leaving them comes back to it.
  act(() => showAppItem("new-project"));
  expect(seen).toEqual({ project: "hivra", item: "new-project" });
  act(() => showProjectToday());
  expect(seen).toEqual({ project: "hivra", item: "inbox" });
  // With no project at all, Today is the empty state that asks for one (HubSurface picks the first once there is one).
  act(() => setHubSelection({ project: NO_PROJECT, item: "" }));
  act(() => showProjectToday());
  expect(seen).toEqual({ project: NO_PROJECT, item: "inbox" });
  expect(JSON.parse(localStorage.getItem("monocode:hub-nav")!).project).not.toBe("today");
});
