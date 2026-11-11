// @vitest-environment happy-dom
// PM's blind r60 G2 (28 Oct): with a new project's draft open, the sidebar still showed Hivra's name and its Coding team,
// Leadership team, Dashboards, Being built and Decisions, as if the draft were one of Hivra's pages.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { hubData, setHubDataSource } from "../model/hubData";
import type { HubProject, ProjectItem } from "../model/types";
import { HubProjectItems } from "./HubProjectItems";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const HIVRA: HubProject = { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "circle" as HubProject["iconShape"], folder: "/repo" };
const ITEMS: ProjectItem[] = [
  { id: "coding-team", kind: "coding-team", title: "Coding team" },
  { id: "leadership", kind: "leadership-team", title: "Leadership team" },
];
let root: Root | undefined;
beforeEach(() => {
  localStorage.clear();
  setHubDataSource(undefined);
  const src = Object.create(hubData());
  src.listProjects = () => [HIVRA];
  src.listProjectItems = () => ITEMS;
  setHubDataSource(src);
});
afterEach(() => act(() => root?.unmount()));
afterAll(() => setHubDataSource(undefined));

async function sidebar(item: string) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(HubProjectItems, { selection: { project: HIVRA.id, item }, onPick: () => undefined })));
  return host;
}

it("shows no project's name or items while a new project's draft is open", async () => {
  const host = await sidebar("new-project");
  expect(host.querySelector("[data-hub-project-header]")).toBeNull();
  expect(host.querySelectorAll("[data-hub-item]")).toHaveLength(0);
  expect(host.textContent ?? "").not.toContain("Hivra");
});

it("still shows the project's teams header (named for the project) and items on the project's own pages", async () => {
  const host = await sidebar("coding-team");
  // Dropwave: the header reads Teams; the project's name heads the sidebar's Home row and stays on the header's title.
  expect(host.querySelector("[data-hub-project-header]")?.textContent).toContain("Teams");
  expect(host.querySelector("[data-hub-project-header] [title]")?.getAttribute("title")).toBe("Hivra");
  expect([...host.querySelectorAll("[data-hub-item]")].map((b) => b.textContent)).toEqual(["Coding team", "Leadership team"]);
});
