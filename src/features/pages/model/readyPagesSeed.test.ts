// @vitest-environment happy-dom
// C8 (Ash: "a few default dashboards that always come with every setup, that just explain the basics"): a fresh setup
// has the four ready-made pages without asking, each explaining itself in a line. An install that already has pages, or
// one where Ash took them away, is never touched, and nothing is kept twice.
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

it("an install that isn't fresh, or already has a page, gets nothing", async () => {
  expect(await seedReadyPages()).toBe(0);
  expect(allPages()).toHaveLength(0);
  await keepPage(buildPreview("a page about builds", "Hub lead"));
  markFreshSetup();
  expect(await seedReadyPages()).toBe(0);
  expect(allPages().map((p) => p.request)).toEqual(["a page about builds"]);
});

it("a page Ash took away is never put back", async () => {
  const p = buildPreview("a page about builds", "Hub lead");
  await keepPage(p);
  await undoBotChange([`page:${p.id}`]);
  expect(allPages()).toHaveLength(0);
  markFreshSetup();
  expect(await seedReadyPages()).toBe(0);
  expect(allPages()).toHaveLength(0);
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
