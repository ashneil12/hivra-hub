// @vitest-environment happy-dom
// A project's Today is its template's board (G1): the cards the template names, drawn from live data, then Being built.
// And, against the stub's own calls over real HTTP (scripts/hub-stub-studio.mjs), the Change the hub history with Undo
// and Redo: a seated Mono's preview, Apply, the history and Bot changes, and a refused Undo said plainly.
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { httpTransport } from "../../../dev/hubTestTransport";
import { applyChange, requestChange, undoChange } from "../../hubChange/model/hubChange";
import { HubChangeContent } from "../../hubChange/ui/HubChangeView";
import { botChangeRows, redoBotChange, undoBotChange } from "../model/botChanges";
import { setHubDataSource } from "../model/hubData";
import { HubStore } from "../model/hubStore";
import { createLiveHubData } from "../model/liveHubData";
import { setTemplate } from "../model/templates";
import { ProjectStrip } from "./ProjectStrip";
import { HubSurface } from "./HubSurface";

// UI timing under a busy Mac (hub:check-all with Xcode builds alongside, load 35+): generous limits, same checks.
vi.setConfig({ testTimeout: 30_000 });

const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
const roster = [{ id: "projects-manager" }, { id: "hivra-lead" }];
let stub: Stub;
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
const ask = (flow: "hub" | "today", prompt: string) => requestChange({ flow, projectId: "today", monoId: "projects-manager", prompt }, { roster });

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
  localStorage.setItem("monocode:mono-roster", JSON.stringify([{ id: "projects-manager", name: "Projects Manager" }, { id: "hivra-lead", name: "Hivra lead" }]));
  stub = await startStub({ buildMs: 0, jobs: true });
  store = new HubStore({ transport: httpTransport(() => stub.url, () => stub.token), ...FAST });
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
  await stub.close();
});

describe("A project's Today draws its template's board", () => {
  it("a game's: Since, Needs you and its latest build, then Being built", async () => {
    act(() => root.render(today("vg-game")));
    await until(() => sections().includes("being-built"), "being built");
    expect(sections()).toEqual(["since", "needs", "latest-build", "being-built"]);
    expect(container.querySelector('[data-hub-today-section="latest-build"]')?.textContent).toContain("No build yet.");
    expect(container.querySelector("[data-hub-today-being-built]")?.textContent).toContain("Example: adding the air dodge");
  });

  it("a product's: the same two, then its latest dashboard", async () => {
    act(() => root.render(today("hivra")));
    // Wait for the last section: Being built can land a tick after the dashboard under load (r61, a flake in the full run).
    await until(() => sections().includes("latest-page") && sections().includes("being-built"), "latest dashboard and being built");
    expect(sections()).toEqual(["since", "needs", "latest-page", "being-built"]);
    expect(container.querySelector('[data-hub-today-section="latest-page"]')?.textContent).toContain("No dashboard yet.");
  });

  it("an ops hub's: just the two, no project card and nothing being built", async () => {
    act(() => root.render(today("hub")));
    await until(() => container.querySelector("[data-hub-since]"), "since");
    expect(sections()).toEqual(["since", "needs"]);
  });

  it("switching project shows that project's own board", async () => {
    act(() => root.render(createElement(Hub, { start: "vg-game" })));
    await until(() => sections().includes("latest-build"), "EXO's builds card");
    const hivra = [...container.querySelectorAll("[data-hub-strip] button")].find((b) => b.textContent?.includes("Hivra")) as HTMLButtonElement;
    await act(async () => hivra.click());
    await until(() => sections().includes("latest-page") && !sections().includes("latest-build"), "Hivra's dashboards card");
    expect(sections()).toEqual(["since", "needs", "latest-page", "being-built"]);
  });

  it("Ash changing a project's template changes its board at once", async () => {
    act(() => root.render(today("hivra")));
    await until(() => sections().includes("latest-page"), "dashboards card");
    act(() => setTemplate("hivra", "game-studio"));
    await until(() => sections().includes("latest-build"), "builds card");
    expect(sections()).toEqual(["since", "needs", "latest-build", "being-built"]);
    act(() => setTemplate("hivra", "org-ops"));
    await until(() => !sections().includes("latest-build"), "no project card");
    expect(sections()).toEqual(["since", "needs", "being-built"]);
    act(() => setTemplate("hivra", "product-saas"));
    await until(() => sections().includes("latest-page"), "back to its dashboards");
  });
});

describe("the change history", () => {
  it("lists each change with Undo or Redo under the ask box; Bot changes shows the same record rows", async () => {
    act(() => root.render(createElement(HubChangeContent, { flow: "hub", projectId: "today" })));
    await until(() => store.getSnapshot().changes, "history read");
    const r = await ask("hub", "rename Nibbii to Nibbii Pet");
    if (r.status !== "ready") throw new Error(r.status);
    await applyChange("hub", r.preview);
    expect(stub.state.projects.find((p) => p.id === "nibbii")?.name).toBe("Nibbii Pet");
    await until(() => container.querySelector(`[data-hub-change-row="${r.preview.previewId}"][data-hub-change-state="applied"]`), "applied row");

    const row = botChangeRows().find((x) => x.kind === "one" && x.change.hubChangeId === r.preview.previewId);
    expect(row?.kind === "one" && row.change.line).toBe("Projects Manager changed the hub: Rename Nibbii to Nibbii Pet");
    await undoBotChange([`hub:${r.preview.previewId}`]);
    expect(stub.state.projects.find((p) => p.id === "nibbii")?.name).toBe("Nibbii");
    await until(() => container.querySelector(`[data-hub-change-row="${r.preview.previewId}"][data-hub-change-state="undone"]`), "undone row");
    await redoBotChange([`hub:${r.preview.previewId}`]);
    expect(stub.state.projects.find((p) => p.id === "nibbii")?.name).toBe("Nibbii Pet");
  });

  it("an Undo that a later change blocks says which one, and changes nothing", async () => {
    await store.start();
    await until(() => store.getSnapshot().status === "ready", "ready");
    const first = await ask("hub", "rename Hivra to Hivra One");
    if (first.status !== "ready") throw new Error(first.status);
    await applyChange("hub", first.preview);
    const second = await ask("hub", "rename Hivra One to Hivra Two");
    if (second.status !== "ready") throw new Error(second.status);
    await applyChange("hub", second.preview);
    await expect(undoChange(first.preview.previewId)).rejects.toThrow("A later change, “Rename Hivra One to Hivra Two”, changed the same thing too. Undo that one first.");
    expect(stub.state.projects.find((p) => p.id === "hivra")?.name).toBe("Hivra Two");
  });

  it("a slow preview says 'still building' and Try again collects it; Connect data says it isn't wired", async () => {
    await stub.close();
    stub = await startStub({ buildMs: 300 });
    const t = httpTransport(() => stub.url, () => stub.token);
    const slow = { call: (a: string, p?: Record<string, unknown>) => t.call(a, { ...p, wait: 0 }), openFeed: t.openFeed };
    const req = { flow: "today" as const, projectId: "today", monoId: "projects-manager", prompt: "hide setup" };
    expect(await requestChange(req, { roster, transport: slow })).toEqual({ status: "building", reason: "Projects Manager is still building this preview. Press Try again in a moment to see it." });
    await new Promise((r) => setTimeout(r, 350));
    const again = await requestChange(req, { roster, transport: slow });
    expect(again.status === "ready" && again.preview.title).toBe("Take Setup off Today");
    expect(stub.studio.changes).toHaveLength(1);
    const connect = await requestChange({ ...req, flow: "connect" }, { roster, transport: t });
    expect(connect.status).toBe("not-connected");
  });
});
