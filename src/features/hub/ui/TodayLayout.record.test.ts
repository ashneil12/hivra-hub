// @vitest-environment happy-dom
// Today drawn from Ash OS's board (`ash-hub-layout`) and the Change the hub / Edit Today history with Undo and Redo,
// against the stub's own calls over real HTTP (scripts/hub-stub-studio.mjs): a seated Mono's preview, Apply, the
// board moving on Today, Undo and Redo from Today, the history and Bot changes, and a refused Undo said plainly.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { httpTransport } from "../../../dev/hubTestTransport";
import { applyChange, requestChange, undoChange } from "../../hubChange/model/hubChange";
import { HubChangeContent } from "../../hubChange/ui/HubChangeView";
import { buildPage } from "../../pages/model/buildPage";
import { keepPage, pageFromSpec, setPagesBackend } from "../../pages/model/pages";
import { botChangeRows, redoBotChange, undoBotChange } from "../model/botChanges";
import { setHubDataSource } from "../model/hubData";
import { HubStore } from "../model/hubStore";
import { createLiveHubData } from "../model/liveHubData";
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
const today = () => createElement(HubSurface, { selection: { project: "today", item: "inbox" } });
const ask = (flow: "hub" | "today", prompt: string) => requestChange({ flow, projectId: "today", monoId: "projects-manager", prompt }, { roster });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem("monocode:mono-roster", JSON.stringify([{ id: "projects-manager", name: "Projects Manager" }, { id: "hivra-lead", name: "Hivra lead" }]));
  stub = await startStub({ buildMs: 0, jobs: true });
  store = new HubStore({ transport: httpTransport(() => stub.url, () => stub.token), ...FAST });
  setHubDataSource(createLiveHubData(store), store);
  setPagesBackend(undefined);
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

/** A kept page in the record, built by the stub's "Mono". */
async function keptPage(prompt: string) {
  const r = await buildPage({ projectId: "hivra", monoId: "hivra-lead", prompt }, { roster });
  if (r.status !== "ready") throw new Error(r.status);
  await keepPage(pageFromSpec(r.spec, prompt, "Hivra lead", "hivra", r.warnings, 1, r.pageId, "hivra-lead"));
  return r.pageId!;
}

describe("Today draws Ash OS's board", () => {
  it("in the shipped order until a change moves it: Since, Setup (only with setup items), Needs you, Being built", async () => {
    act(() => root.render(today()));
    await until(() => store.getSnapshot().today, "layout read");
    await until(() => sections().includes("being-built"), "being built on Today");
    expect(sections()).toEqual(["since", "needs", "being-built"]);
    expect(container.querySelector("[data-hub-today-being-built]")?.textContent).toContain("Example: adding the air dodge");
  });

  it("an applied Edit Today change puts a kept page on Today, Undo on Today takes it off, Redo puts it back", async () => {
    act(() => root.render(today()));
    await until(() => store.getSnapshot().today, "layout read");
    const pageId = await keptPage("Sign-ups this week");
    const r = await ask("today", "put my sign-ups page on Today");
    if (r.status !== "ready") throw new Error(`${r.status}: ${"reason" in r ? r.reason : ""}`);
    expect(r.preview.preview.sections[0].rows).toEqual(["Since you were away", "Page: Example: Sign-ups this week", "Setup", "Needs you", "Being built"]);
    // A preview never touches the live board.
    expect(stub.studio.today.map((s) => s.id)).toEqual(["since", "setup", "needs", "being-built"]);
    expect(await applyChange("today", r.preview, { roster } as never)).toEqual({ status: "applied" });
    await until(() => container.querySelector(`[data-hub-today-page="${pageId}"]`), "page on Today");
    expect(sections()).toEqual(["since", "page", "needs", "being-built"]);
    expect(container.querySelector(`[data-hub-today-page="${pageId}"]`)?.textContent).toContain("Example: Sign-ups this week");

    // The last change sits on Today with its Undo.
    await until(() => container.querySelector("[data-hub-today-last-change] [data-hub-change-row-undo]"), "last change line");
    expect(container.querySelector("[data-hub-today-last-change]")?.textContent).toContain("Projects Manager changed Today: Put “Example: Sign-ups this week” on Today");
    await act(async () => (container.querySelector("[data-hub-today-last-change] [data-hub-change-row-undo]") as HTMLButtonElement).click());
    await until(() => !container.querySelector(`[data-hub-today-page="${pageId}"]`), "page off Today after Undo");
    expect(stub.studio.changes[0].state).toBe("undone");
    await until(() => container.querySelector("[data-hub-today-last-change] [data-hub-change-row-redo]"), "Redo offered");
    await act(async () => (container.querySelector("[data-hub-today-last-change] [data-hub-change-row-redo]") as HTMLButtonElement).click());
    await until(() => container.querySelector(`[data-hub-today-page="${pageId}"]`), "page back after Redo");
  });

  it("renamed and removed sections show as Ash OS has them", async () => {
    act(() => root.render(today()));
    await until(() => store.getSnapshot().today, "layout read");
    for (const prompt of ["rename Needs you to Waiting on me", "hide being built"]) {
      const r = await ask("today", prompt);
      if (r.status !== "ready") throw new Error(r.status);
      await applyChange("today", r.preview);
    }
    await until(() => container.querySelector("[data-hub-needs-heading]"), "renamed heading");
    expect(container.querySelector("[data-hub-needs-heading]")?.textContent).toBe("Waiting on me");
    expect(sections()).not.toContain("being-built");
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
