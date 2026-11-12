// @vitest-environment happy-dom
// Only the open thing is highlighted in the sidebar (PM's real-app check of r35, 22 Oct: "Coding team" stayed highlighted
// while the Hub lead's 1:1 was open, so two rows looked open at once). With a Mono's 1:1 open the Monos rail marks that
// Mono and no project item is highlighted; close the 1:1 and the item Ash was on is highlighted again.
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
  { id: "being-built", kind: "being-built", title: "Being built" },
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

async function highlighted(item: string, monoOpen: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(HubProjectItems, { selection: { project: PROJECT.id, item }, onPick: () => undefined, monoOpen })));
  return [...host.querySelectorAll<HTMLButtonElement>("[data-hub-item]")]
    .filter((b) => b.className.split(/\s+/).includes("bg-selection") || b.getAttribute("aria-current"))
    .map((b) => b.textContent);
}

it("with no 1:1 open, the item Ash is on is the one highlighted", async () => {
  // Dropwave (Ash, 11 Nov): the Coding team row is gone, so it is never the highlighted one.
  expect(await highlighted("coding-team", false)).toEqual([]);
  act(() => root?.unmount());
  expect(await highlighted("leadership", false)).toEqual(["Leadership team"]);
});

it("with a Mono's 1:1 open, neither Coding team nor Leadership team stays highlighted", async () => {
  expect(await highlighted("coding-team", true)).toEqual([]);
  act(() => root?.unmount());
  expect(await highlighted("leadership", true)).toEqual([]);
});
