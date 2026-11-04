// @vitest-environment happy-dom
// A project's Today is its template's board (G1): the cards the template names, drawn from the app's own data, then
// Being built. Since WP-04 there is no Ash OS: Needs you and Being built are empty states until WP-14's decision store.
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localTestHub } from "../../../dev/hubTestTransport";
import { setHubDataSource } from "../model/hubData";
import { HubStore } from "../model/hubStore";
import { createLiveHubData } from "../model/liveHubData";
import { setTemplate } from "../model/templates";
import { ProjectStrip } from "./ProjectStrip";
import { HubSurface } from "./HubSurface";

// UI timing under a busy Mac (hub:check-all with Xcode builds alongside, load 35+): generous limits, same checks.
vi.setConfig({ testTimeout: 30_000 });

const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let store: HubStore;
let root: Root;
let container: HTMLElement;

async function until(read: () => unknown, what: string, ms = 15000) {
  const end = Date.now() + ms;
  while (!read()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${container.textContent}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}
const sections = () => [...container.querySelectorAll("[data-hub-today-section]")].map((s) => s.getAttribute("data-hub-today-section"));
// A project is the unit of the hub (G1): a project's Today, never a board of all projects.
const today = (project = "vg-game") => createElement(HubSurface, { selection: { project, item: "inbox" } });

/** A strip and the project's surface, as the app arranges them: picking a project opens that project's Today. */
function Hub({ start }: { start: string }) {
  const [project, setProject] = useState(start);
  const selection = { project, item: "inbox" };
  return createElement(
    "div",
    null,
    createElement(ProjectStrip, { selection, onPickProject: (p) => setProject(p.id), onCreateProject: () => undefined }),
    createElement(HubSurface, { selection }),
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem("monocode:mono-roster", JSON.stringify([{ id: "bo", name: "Projects Manager" }, { id: "hivra-lead", name: "Hivra lead" }]));
  store = new HubStore({ transport: (await localTestHub()).transport, ...FAST });
  setHubDataSource(createLiveHubData(store), store);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await new Promise((r) => setTimeout(r, 20));
  store.stop();
  setHubDataSource(undefined);
});

describe("A project's Today draws its template's board", () => {
  it("a game's: Since, Needs you and its latest build (Being built hides with nothing in it)", async () => {
    act(() => root.render(today("vg-game")));
    await until(() => sections().includes("needs"), "needs");
    expect(sections()).toEqual(["since", "needs", "latest-build"]);
    expect(container.querySelector('[data-hub-today-section="latest-build"]')?.textContent).toContain("No build yet.");
    // Nothing is being built yet (the app's own delegations; none here), so that card hides.
    expect(container.querySelector("[data-hub-today-being-built]")).toBeNull();
  });

  it("a product's: the same two, then its latest dashboard", async () => {
    act(() => root.render(today("hivra")));
    // Wait for the last section: Being built can land a tick after the dashboard under load (r61, a flake in the full run).
    await until(() => sections().includes("needs"), "needs");
    // r65: no dashboard kept yet, so its card hides rather than saying so.
    expect(sections()).toEqual(["since", "needs"]);
    expect(container.textContent).not.toContain("No dashboard yet");
  });

  it("an ops hub's: just the two, no project card", async () => {
    act(() => root.render(today("hub")));
    await until(() => container.querySelector("[data-hub-since]"), "since");
    expect(sections()).toEqual(["since", "needs"]);
  });

  it("switching project shows that project's own board", async () => {
    act(() => root.render(createElement(Hub, { start: "vg-game" })));
    await until(() => sections().includes("latest-build"), "EXO's builds card");
    const hivra = [...container.querySelectorAll("[data-hub-strip] button")].find((b) => b.textContent?.includes("Hivra")) as HTMLButtonElement;
    await act(async () => hivra.click());
    await until(() => !sections().includes("latest-build"), "Hivra's board");
    // r65: no dashboard kept for Hivra, so that card hides.
    expect(sections()).toEqual(["since", "needs"]);
  });

  it("Ash changing a project's template changes its board at once", async () => {
    act(() => root.render(today("hivra")));
    await until(() => sections().includes("needs"), "Hivra's board");
    act(() => setTemplate("hivra", "game-studio"));
    // Each section lands on its own render: wait for the last one, not the first (flaked in the full run under load).
    await until(() => sections().includes("latest-build"), "builds card");
    expect(sections()).toEqual(["since", "needs", "latest-build"]);
    act(() => setTemplate("hivra", "org-ops"));
    await until(() => !sections().includes("latest-build"), "no project card");
    expect(sections()).toEqual(["since", "needs"]);
    act(() => setTemplate("hivra", "product-saas"));
    await until(() => !sections().includes("latest-build"), "back to its board");
    expect(sections()).toEqual(["since", "needs"]);
  });
});
