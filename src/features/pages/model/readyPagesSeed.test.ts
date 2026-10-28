// @vitest-environment happy-dom
// C8 (Ash: "a few default dashboards that always come with every setup, that just explain the basics"): a fresh setup
// has the four ready-made pages without asking, each explaining itself in a line. r61: so does an install from before C8;
// a ready page Ash took away is never put back, and nothing is kept twice.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeEach, expect, it } from "vitest";
import { allPages, keepPage, buildPreview, needsAllow, resetPagesForTest } from "./pages";
import { undoBotChange } from "../../hub/model/botChanges";
import { READY_PAGES } from "./readyPages";
import { markFreshSetup, seedReadyPages } from "./readyPagesSeed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  localStorage.clear();
  resetPagesForTest();
});
afterAll(() => resetPagesForTest());

it("a fresh setup keeps the four ready-made pages once, in order, each asking Keep and allow before it may do anything", async () => {
  markFreshSetup();
  expect(await seedReadyPages()).toBe(4);
  expect(allPages().map((p) => p.title)).toEqual(["Agents", "Needs you", "Being built", "Projects"]);
  expect(allPages().every((p) => p.by === "Ready-made" && p.permissions.length === 0 && needsAllow(p))).toBe(true);
  markFreshSetup();
  expect(await seedReadyPages()).toBe(0);
  expect(allPages()).toHaveLength(4);
});

it("r61: an install from before C8, with its own pages, gets the four once too; its own pages stay", async () => {
  await keepPage(buildPreview("a page about builds", "Hub lead", 1), 1);
  expect(await seedReadyPages()).toBe(4);
  expect(allPages().map((p) => p.title).slice(0, 4)).toEqual(["Agents", "Needs you", "Being built", "Projects"]);
  expect(allPages().map((p) => p.request)).toContain("a page about builds");
  expect(await seedReadyPages()).toBe(0);
  expect(allPages()).toHaveLength(5);
});

it("a ready page Ash took away is never put back, and one already kept is not kept twice", async () => {
  markFreshSetup();
  expect(await seedReadyPages()).toBe(4);
  const agents = allPages().find((p) => p.title === "Agents")!;
  await undoBotChange([`page:${agents.id}`]);
  expect(allPages().map((p) => p.title)).not.toContain("Agents");
  // Even with the seeded flag gone (a reinstall that kept this Mac's pages), nothing comes back or doubles.
  localStorage.removeItem("monocode:ready-pages-seeded-v2");
  expect(await seedReadyPages()).toBe(0);
  expect(allPages().map((p) => p.title)).toEqual(["Needs you", "Being built", "Projects"]);
});

it("Pages lists each one with the line that explains it", async () => {
  markFreshSetup();
  await seedReadyPages();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const { PagesContent } = await import("../ui/PagesView");
  await act(async () => root.render(createElement(PagesContent)));
  const lines = [...host.querySelectorAll("[data-pages-row] [data-pages-what]")].map((e) => e.textContent);
  expect(lines).toEqual(READY_PAGES.map((r) => r.what));
  // Opened, it says the same line under its title, and asks Keep and allow.
  await act(async () => (host.querySelector("[data-pages-row] button") as HTMLButtonElement).click());
  expect(host.querySelector("[data-pages-open] [data-pages-what]")?.textContent).toBe(READY_PAGES[0].what);
  act(() => root.unmount());
  host.remove();
});

it("the first-launch gate marks a fresh setup and the four are there without asking", async () => {
  const { HubOnboardingGate } = await import("../../hub/ui/HubOnboardingGate");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(HubOnboardingGate)));
  for (let i = 0; i < 20 && allPages().length < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  expect(allPages().map((p) => p.title)).toEqual(["Agents", "Needs you", "Being built", "Projects"]);
  act(() => root.unmount());
  host.remove();
});
