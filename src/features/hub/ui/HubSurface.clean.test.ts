// @vitest-environment happy-dom
// Ships clean: without the dev/demo flag there is no example data anywhere (no example bots, no Operator OS), and
// Today on a first launch is one calm line and a New project button. With the flag, the demo data has a project with
// more than five Needs, so the Later fold is exercised: five on Today, the rest under Later.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: Root;
let container: HTMLElement;
const text = () => container.textContent ?? "";

/** Fresh modules, so the example stores read the flag as it is now (they read it once, when loaded). */
async function load(flag: boolean) {
  localStorage.clear();
  if (flag) localStorage.setItem("monocode:hub-examples", "1");
  vi.resetModules();
  const mock = await import("../model/mockData");
  const data = await import("../model/hubData");
  data.setHubDataSource(mock.mockHubData);
  return {
    mock,
    work: await import("../model/hubWork"),
    chats: await import("../model/hubChats"),
    builds: await import("../model/hubBuilds"),
    waiting: await import("../model/waiting"),
    HubSurface: (await import("./HubSurface")).HubSurface,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

describe("ships clean", () => {
  it("has no example projects, bots, jobs, chats or builds without the flag", async () => {
    const { mock, work, chats, builds } = await load(false);
    expect(mock.mockHubData.listProjects()).toEqual([]);
    expect(mock.mockHubData.listNeeds()).toEqual([]);
    expect(mock.mockHubData.listStuck()).toEqual([]);
    expect(JSON.stringify(mock.mockHubData.listProjects())).not.toContain("Operator");
    expect(work.activeWorkers("exo-game")).toEqual([]);
    expect(chats.listChats("exo-game")).toEqual([]);
    expect(builds.listBuilds("exo-game")).toEqual([]);
  });

  it("first launch: Today is one calm line and a New project button, nothing else", async () => {
    const { HubSurface } = await load(false);
    act(() => root.render(createElement(HubSurface, { selection: { project: "today", item: "inbox" } })));
    const empty = container.querySelector("[data-hub-today-empty]")!;
    expect(empty).toBeTruthy();
    expect(empty.querySelectorAll("p").length).toBe(1);
    expect(container.querySelector("[data-hub-today-new-project]")?.textContent).toBe("New project");
    expect(text()).not.toMatch(/Example|Operator|Playtester|Hivra|EXO/);
    expect(container.querySelector("[data-hub-need]")).toBeNull();
  });
});

describe("at most five Needs per project on Today", () => {
  it("the demo data has a project with more than five, and the rest fold under Later", async () => {
    const { mock, waiting } = await load(true);
    const exo = mock.mockHubData.listNeeds("exo-game");
    expect(exo.length).toBeGreaterThan(waiting.MAX_NEEDS);
    const shown = waiting.waitingOnAsh("exo-game").filter((w) => w.need);
    expect(shown.length).toBe(waiting.MAX_NEEDS);
    // The Needs past five come first under Later (a proposal is a Need too, so it waits there after them).
    const later = waiting.laterItems("exo-game").map((w) => w.id);
    expect(later.slice(0, exo.length - waiting.MAX_NEEDS)).toEqual(exo.slice(waiting.MAX_NEEDS).map((n) => n.id));
  });

  it("Today shows five rows for that project and opens the rest from Later", async () => {
    const { mock, waiting, HubSurface } = await load(true);
    const laterCount = waiting.laterItems("exo-game").length;
    const exo = mock.mockHubData.listNeeds("exo-game");
    act(() => root.render(createElement(HubSurface, { selection: { project: "today", item: "inbox" } })));
    const ids = new Set(exo.map((n) => n.id));
    const rows = () => [...container.querySelectorAll("[data-hub-need]")].map((r) => r.getAttribute("data-hub-need")!).filter((id) => ids.has(id));
    expect(rows().length).toBe(5);
    const fold = [...container.querySelectorAll("[data-hub-later] button")].find((b) => b.textContent === `${laterCount} more under Later`) as HTMLButtonElement;
    expect(fold).toBeTruthy();
    await act(async () => fold.click());
    expect(rows().length).toBe(exo.length);
  });
});
