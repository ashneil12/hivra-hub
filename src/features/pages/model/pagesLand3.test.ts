// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeEach, expect, it } from "vitest";
import { addMono } from "../../monos/model/mono";
import { botChangeRows, undoAllFrom } from "../../hub/model/botChanges";
import { allPages, buildPreview, keepPage, pinnedPages, resetPagesForTest, setPinned } from "./pages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(async () => {
  localStorage.clear(); resetPagesForTest();
  const { hubData, setHubDataSource } = await import("../../hub/model/hubData");
  setHubDataSource(undefined);
  const base = hubData();
  const src = Object.create(base);
  src.listProjects = () => [["hivra", "Hivra"], ["nibbii", "Nibbii"]].map(([id, name]) => ({ id, name, shortName: name, iconShape: "folder", folder: `/Users/ash/harness/${id}` }));
  setHubDataSource(src);
});

async function render() {
  const { PagesContent } = await import("../ui/PagesView");
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(createElement(PagesContent)));
  return host;
}

it("the Mono picker lists seated Monos only and defaults to a seated Mono", async () => {
  addMono({ id: "bo", name: "Bo", mascot: "robot", color: "x", projects: [] });
  addMono({ id: "hivra-lead", name: "Hivra lead", mascot: "robot", color: "x", projects: [] });
  const host = await render();
  const picker = host.querySelector("[data-pages-mono-picker]") as HTMLSelectElement;
  const ids = [...picker.options].map((o) => o.value);
  expect(ids).toContain("hivra-lead");
  expect(ids).not.toContain("worker-1");
  expect(ids).toContain(picker.value);
});

it("the project's lead is the default builder when it's seated and works on that project", async () => {
  const { defaultBuilder } = await import("../ui/PagesView");
  const { hubData } = await import("../../hub/model/hubData");
  const { ensureProjectLeads } = await import("../../hub/model/hubLeads");
  const project = hubData().listProjects()[0];
  addMono({ id: "bo", name: "Bo", mascot: "robot", color: "x", projects: [] });
  ensureProjectLeads([project]);
  expect(defaultBuilder(project.id, [{ id: "bo" }, { id: "hivra-lead" }])).toBe("hivra-lead");
  expect(defaultBuilder(project.id, [{ id: "bo" }])).toBe("bo");
});

it("every project has a tab; one with no pages says No pages yet; cross-project pages are 'Not tied to a project'", async () => {
  keepPage(buildPreview("hivra sign-ups", "Hivra lead", 1, "hivra"));
  keepPage(buildPreview("my week", "Ada", 2, "today"));
  const host = await render();
  const tabs = [...host.querySelectorAll('[aria-label="Filter by project"] [role=tab]')].map((t) => t.textContent);
  expect(tabs).toContain("Nibbii");
  expect(tabs).toContain("Not tied to a project");
  expect(host.querySelector('[data-pages-group="today"] h2')!.textContent).toBe("Not tied to a project");
  const nibbii = [...host.querySelectorAll('[role=tab]')].find((t) => t.textContent === "Nibbii") as HTMLButtonElement;
  await act(async () => nibbii.click());
  expect(host.querySelector("[data-pages-filter-empty]")!.textContent).toContain("No hubs yet");
});

it("unpinned pins show only on row hover; pinned stay solid", async () => {
  keepPage(buildPreview("a", "Hivra lead", 1, "hivra"));
  keepPage(buildPreview("b", "Hivra lead", 2, "hivra"));
  setPinned(allPages()[0].id, true);
  const host = await render();
  const pins = [...host.querySelectorAll("[data-pages-row] [data-pages-pin]")];
  const on = pins.find((p) => p.getAttribute("aria-pressed") === "true")!;
  const off = pins.find((p) => p.getAttribute("aria-pressed") === "false")!;
  expect(on.className).toMatch(/\btext-content(\s|$)/);
  expect(on.className).not.toContain("opacity-0");
  expect(off.className).toMatch(/opacity-0[^"]*group-hover:opacity-100/);
  expect(off.className).toContain("text-content/70");
});

it("a Mono's pin or unpin is a Bot changes row under that Mono, and Undo all from covers it", async () => {
  keepPage(buildPreview("a", "Hivra lead", 1, "hivra"));
  const id = allPages()[0].id;
  setPinned(id, true, "Hivra lead");
  const rows = botChangeRows().flatMap((r) => (r.kind === "one" ? [r.change] : r.items));
  expect(rows.some((c) => c.bot === "Hivra lead" && c.pin?.pageId === id && c.pin.pinned)).toBe(true);
  setPinned(id, false);
  setPinned(id, true, "Hivra lead");
  await undoAllFrom("Hivra lead");
  expect(pinnedPages()).toHaveLength(0);
});
afterAll(async () => (await import("../../hub/model/hubData")).setHubDataSource(undefined));
