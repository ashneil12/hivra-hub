// @vitest-environment happy-dom
// WP-71 put Tasks next to the coding team. Dropwave took both rows out of the sidebar.
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

// Dropwave (Ash, 11 Nov: "coding team in and of itself is kind of a redundant area now", "tasks, I don't really
// understand"): neither row is in the sidebar. Chats happen with the Chief of Staff and the first mates above the teams.
it("lists the project's teams with no Coding team row and no Tasks row", async () => {
  for (const item of ["coding-team", "tasks", "leadership"]) {
    const host = await render(item);
    const labels = [...host.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(labels).not.toContain("Coding team");
    expect(labels).not.toContain("Tasks");
    expect(host.querySelector("[data-hub-tasks]")).toBeNull();
    expect([...host.querySelectorAll("[data-hub-item]")].map((button) => button.textContent?.trim())).toEqual(["Leadership team"]);
    act(() => root?.unmount());
  }
});
