// @vitest-environment happy-dom
// Ships clean: without the dev/demo flag there is no example data anywhere (no example bots, no example projects such as Harness).
// A first launch with no project is one calm line, New project, and Restore. It is not a Today board.
// With the flag, the demo data has a project with more than five open rows. The Today list and its Later fold are gone.
// The strip badge still counts at most five of those rows (stuck included). The rest are not shown.
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
  }, 20_000);

  it("first launch: one calm line, New project, and restore, and no example data", async () => {
    const { HubSurface } = await load(false);
    // No project chosen and none to open: the create-a-project empty state. There is no all-projects board.
    act(() => root.render(createElement(HubSurface, { selection: { project: "", item: "" } })));
    const empty = container.querySelector("[data-hub-today-empty]")!;
    expect(container.querySelector("[data-hub-surface]")?.getAttribute("aria-label")).toBe("Projects");
    expect(empty).toBeTruthy();
    expect(empty.querySelectorAll("p").length).toBe(1);
    expect(empty.querySelector("[data-hub-today-empty-line]")?.textContent).toBe("No projects yet. Start one to talk with its coding team.");
    expect(container.querySelector("[data-hub-today-new-project]")?.textContent).toBe("New project");
    expect(container.querySelector("[data-hub-today-restore]")?.textContent).toBe("Restore from an export");
    expect(text()).not.toMatch(/Example|Operator|Playtester|Hivra|EXO/);
    expect(container.querySelector("[data-hub-need]")).toBeNull();
    // No project's board, and no all-projects one either: nothing to read until a project exists.
    expect(container.querySelectorAll("[data-hub-today-section]").length).toBe(0);
    expect(text()).not.toContain("Today for all projects");
  });
});

describe("the strip badge counts at most five open rows", () => {
  it("stuck rows count toward the five and come first; rows past the cap are not on the badge", async () => {
    const { mock, waiting } = await load(true);
    const exo = mock.mockHubData.listNeeds("exo-game");
    expect(exo.length).toBeGreaterThan(waiting.MAX_NEEDS);
    const shown = waiting.waitingOnAsh("exo-game").filter((w) => !w.done);
    expect(shown.length).toBe(waiting.MAX_NEEDS);
    const stuck = shown.filter((w) => w.state);
    expect(stuck.length).toBeGreaterThan(0);
    // Stuck first, then Needs.
    expect(shown.slice(0, stuck.length).every((w) => w.state)).toBe(true);
    // Rows past the cap are not counted. The Today list's Later fold is gone, so nothing shows them.
    const shownNeeds = shown.filter((w) => w.need).length;
    expect(waiting.laterItems("exo-game").map((w) => w.id).slice(0, exo.length - shownNeeds)).toEqual(exo.slice(shownNeeds).map((n) => n.id));
    expect(shown.map((w) => w.id)).not.toEqual(expect.arrayContaining(waiting.laterItems("exo-game").map((w) => w.id)));
  });

  it("no project shows more than five open rows", async () => {
    const { mock, waiting } = await load(true);
    for (const p of mock.mockHubData.listProjects()) {
      expect(waiting.waitingOnAsh(p.id).filter((w) => !w.done).length).toBeLessThanOrEqual(waiting.MAX_NEEDS);
    }
  });

});
