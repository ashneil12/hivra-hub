// @vitest-environment happy-dom
// D2 (Ash, 19 Oct: "nothing sorts in the background", so the app must show what holds). WP-06: Being built and the
// project's Decisions row are not in the sidebar, and a stored Decisions item is not a page. Settings → Decisions
// still lists every project, and one project's page shows only that project's asks and memory.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../model/hubMemoryPrimer", () => ({
  fetchMemoryPrimer: async (project: string) => ({
    text: `## ${project}: decisions, newest first\n- ${project === "hivra" ? "Ship the web build first" : "Keep the old shader"} [20 Oct]\n`,
    memory_dir: `~/agent-memory/${project}`,
    global_dir: "~/agent-memory/ash",
  }),
}));

import { hubData, setHubDataSource } from "../model/hubData";
import type { HubProject, Need, ProjectItem } from "../model/types";
import { HubProjectItems } from "./HubProjectItems";
import { DecisionsPage } from "./DecisionsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const project = (id: string, name: string): HubProject =>
  ({ id, name, shortName: name, iconShape: "circle", folder: "/repo" }) as HubProject;
const PROJECTS = [project("hivra", "Hivra"), project("exo-game", "Exo game")];
const ITEMS: ProjectItem[] = [{ id: "being-built", kind: "being-built", title: "Being built" }];
const NEEDS: Record<string, Need[]> = {
  hivra: [{ id: "n1", projectId: "hivra", title: "Pick the launch day", why: "The Lead needs a date", actionType: "open", actionLabel: "Open" } as Need],
  "exo-game": [{ id: "n2", projectId: "exo-game", title: "Approve the new art", why: "Two styles", actionType: "open", actionLabel: "Open" } as Need],
};
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  setHubDataSource(undefined);
  const src = Object.create(hubData());
  src.listProjects = () => PROJECTS;
  src.listProjectItems = () => ITEMS;
  src.listNeeds = (id?: string) => (id ? NEEDS[id] ?? [] : Object.values(NEEDS).flat());
  setHubDataSource(src);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
});
afterAll(() => setHubDataSource(undefined));

const until = async (ok: () => unknown) => {
  for (let i = 0; i < 50 && !ok(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
};

it("the sidebar does not list Being built or Decisions", async () => {
  await act(async () => root!.render(createElement(HubProjectItems, { selection: { project: "exo-game", item: "coding-team" }, onPick: () => undefined })));
  const rows = [...host.querySelectorAll<HTMLButtonElement>("[data-hub-item]")].map((b) => b.textContent);
  expect(rows).not.toContain("Being built");
  expect(rows).not.toContain("Decisions");
});

it("a project's Decisions shows only that project: its asks and its memory, with no project picker", async () => {
  await act(async () => root!.render(createElement(DecisionsPage, { projectId: "exo-game" })));
  await until(() => host.querySelector("[data-hub-decision-line]"));
  expect(host.querySelector("[data-hub-decisions-projects]")).toBeNull();
  expect(host.textContent).toContain("Approve the new art");
  expect(host.textContent).toContain("Keep the old shader");
  expect(host.textContent).not.toContain("Pick the launch day");
  expect(host.textContent).not.toContain("Ship the web build first");
});

it("Settings → Decisions still offers every project", async () => {
  await act(async () => root!.render(createElement(DecisionsPage)));
  await until(() => host.querySelector("[data-hub-decision-line]"));
  expect([...host.querySelectorAll("[data-hub-decisions-project]")].map((b) => b.textContent)).toEqual(["Hivra", "Exo game"]);
});

it("a stored Decisions item is not a project page", async () => {
  const { HubSurface } = await import("./HubSurface");
  await act(async () => root!.render(createElement(HubSurface, { selection: { project: "exo-game", item: "decisions" } })));
  expect(host.querySelector("[data-hub-project-decisions]")).toBeNull();
  expect(host.textContent ?? "").not.toContain("Approve the new art");
});
