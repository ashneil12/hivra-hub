// @vitest-environment happy-dom
// WP-71: Tasks sits next to the coding team and is not one of the stored project items.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { hubData, setHubDataSource } from "../model/hubData";
import type { HubProject, ProjectItem } from "../model/types";
import { HubProjectItems } from "./HubProjectItems";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const PROJECT: HubProject = { id: "example-hub", name: "Example: Hub", shortName: "Hub", iconShape: "circle" as HubProject["iconShape"], folder: "/repo" };
const ITEMS: ProjectItem[] = [
  { id: "coding-team", kind: "coding-team", title: "Coding team" },
  { id: "leadership", kind: "leadership-team", title: "Leadership team" },
];
let root: Root | undefined;

beforeEach(() => {
  localStorage.clear();
  setHubDataSource(undefined);
  const src = Object.create(hubData());
  src.listProjects = () => [PROJECT];
  src.listProjectItems = () => ITEMS;
  setHubDataSource(src);
});
afterEach(() => act(() => root?.unmount()));
afterAll(() => setHubDataSource(undefined));

async function render(item: string, monoOpen = false) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(HubProjectItems, { selection: { project: PROJECT.id, item }, onPick: () => undefined, monoOpen })));
  return host;
}

it("puts Tasks next to the coding team, and only highlights it when Tasks is open", async () => {
  const onTeam = await render("coding-team");
  const labels = [...onTeam.querySelectorAll("button")].map((button) => button.textContent?.trim());
  expect(labels.indexOf("Tasks")).toBe(labels.indexOf("Coding team") + 1);
  const tasks = onTeam.querySelector<HTMLButtonElement>("[data-hub-tasks]");
  expect(tasks?.hasAttribute("data-hub-item")).toBe(false);
  expect(tasks?.getAttribute("aria-current")).toBeNull();
  expect(tasks?.className.includes("bg-selection")).toBe(false);
  act(() => root?.unmount());
  const onTasks = await render("tasks");
  const current = onTasks.querySelector<HTMLButtonElement>("[data-hub-tasks]");
  expect(current?.getAttribute("aria-current")).toBe("page");
  expect([...onTasks.querySelectorAll("[data-hub-item]")].some((button) => button.getAttribute("aria-current") === "page")).toBe(false);
  act(() => root?.unmount());
  const covered = await render("tasks", true);
  expect(covered.querySelector("[data-hub-tasks]")?.getAttribute("aria-current")).toBeNull();
});
