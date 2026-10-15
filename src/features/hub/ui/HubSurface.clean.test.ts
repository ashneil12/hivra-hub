// @vitest-environment happy-dom
// Ships clean: without the dev/demo flag there is no example data anywhere (no example bots, no example projects such as Harness), and
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

describe("at most five rows per project on Today", () => {
  it("stuck rows count toward the five and come first; the rest fold under Later", async () => {
    const { mock, waiting } = await load(true);
    const exo = mock.mockHubData.listNeeds("exo-game");
    expect(exo.length).toBeGreaterThan(waiting.MAX_NEEDS);
    const shown = waiting.waitingOnAsh("exo-game").filter((w) => !w.done);
    expect(shown.length).toBe(waiting.MAX_NEEDS);
    const stuck = shown.filter((w) => w.state);
    expect(stuck.length).toBeGreaterThan(0);
    // Stuck first, then Needs.
    expect(shown.slice(0, stuck.length).every((w) => w.state)).toBe(true);
    // The Needs that did not fit come first under Later, in order.
    const shownNeeds = shown.filter((w) => w.need).length;
    const later = waiting.laterItems("exo-game").map((w) => w.id);
    expect(later.slice(0, exo.length - shownNeeds)).toEqual(exo.slice(shownNeeds).map((n) => n.id));
  });

  it("no project shows more than five open rows", async () => {
    const { mock, waiting } = await load(true);
    for (const p of mock.mockHubData.listProjects()) {
      expect(waiting.waitingOnAsh(p.id).filter((w) => !w.done).length).toBeLessThanOrEqual(waiting.MAX_NEEDS);
    }
  });

  it("the strip badge equals the open rows Today shows for the project, stuck included", async () => {
    const { mock, waiting } = await load(true);
    for (const p of mock.mockHubData.listProjects()) {
      const visible = waiting.waitingOnAsh(p.id).filter((w) => !w.done).length;
      expect(waiting.waitingCount(p.id)).toBe(visible);
      expect(waiting.waitingCount(p.id)).toBeLessThanOrEqual(waiting.MAX_NEEDS);
    }
  });

  it("Today shows five rows for that project; the Later line is a real button and opens the rest", async () => {
    const { waiting, HubSurface } = await load(true);
    const laterCount = waiting.laterItems("exo-game").length;
    act(() => root.render(createElement(HubSurface, { selection: { project: "today", item: "inbox" } })));
    const section = [...container.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "EXO game" || s.querySelector("[data-hub-later]")) as HTMLElement;
    expect(section).toBeTruthy();
    const fold = section.querySelector("[data-hub-later-toggle]") as HTMLButtonElement;
    expect(fold.tagName).toBe("BUTTON");
    expect(fold.textContent).toBe(`${laterCount} more under Later`);
    expect(fold.className).toMatch(/underline/);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fold.click());
    expect(section.querySelector("[data-hub-later-toggle]")!.getAttribute("aria-expanded")).toBe("true");
    expect(section.querySelectorAll("[data-hub-later] [data-hub-need]").length).toBeGreaterThan(0);
    // Open: a quiet heading in line with the rows, dimmed rows, and Hide Later in line underneath.
    expect(section.querySelector("[data-hub-later-heading]")?.textContent).toBe("Later");
    expect(section.querySelector("[data-hub-later-rows]")?.className).toMatch(/opacity-75/);
    const hide = section.querySelector("[data-hub-later-toggle]") as HTMLButtonElement;
    expect(hide.textContent).toBe("Hide Later");
    expect(section.querySelector("[data-hub-later-rows]")!.compareDocumentPosition(hide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => hide.click());
    expect(section.querySelector("[data-hub-later-heading]")).toBeNull();
  });
});
