// @vitest-environment happy-dom
// Projects in the app's own local store (WP-04; src/dev/hubTestTransport.ts): New project's Create (nothing is made
// before it; the project, its folder at ~/Projects/<id>, its Lead), rename, the shape picker and taking a project off
// the hub with Undo. Nothing is made on disk here: the folder command answers an invented path.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localTestHub, type TestHub } from "../../../dev/hubTestTransport";
import { findMono } from "../../monos/model/mono";
import { setHubDataSource } from "../model/hubData";
import { leadFor } from "../model/hubLeads";
import { HubStore } from "../model/hubStore";
import { createLiveHubData } from "../model/liveHubData";
import { moveLocalNamesToAshOs, resetNameMoveForTest } from "../model/projectActions";
import { saveProjectDraft, projectDraft } from "../model/projectDraft";
import { pendingUndo, setProjectFileActions } from "../model/projectPrefs";
import { templateOf } from "../model/templates";
import { NewProjectView } from "./NewProjectView";
import { ProjectMenu, RemoveFromHub } from "./ProjectMenu";
import { ProjectStrip } from "./ProjectStrip";
import { HubProjectItems } from "./HubProjectItems";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { id?: string }) => {
    if (command === "plugin:hub|local_hub_make_folder") return `/Users/example/Projects/${args?.id}`;
    throw new Error("no native side in this test");
  }),
}));

const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let t: TestHub;
let store: HubStore;
let root: Root;
let container: HTMLElement;

async function until(read: () => unknown, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await read())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${container.textContent}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}
const q = (s: string) => container.querySelector(s) as HTMLElement | null;
/** Popovers open on document.body. */
const dq = (s: string) => document.querySelector(s) as HTMLElement | null;
const strip = () => createElement(ProjectStrip, { selection: { project: "today", item: "inbox" }, onPickProject: () => undefined, onCreateProject: () => undefined });
const stripLabels = () => [...container.querySelectorAll("[data-hub-strip] button span.truncate")].map((s) => s.textContent);
const calls = (name: string) => t.calls.filter((a) => a === name).length;
const kept = async () => (await t.state()).projects;
const project = (id: string) => store.getSnapshot().projects.find((p) => p.id === id)!;
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  sessionStorage.clear();
  resetNameMoveForTest();
  t = await localTestHub();
  store = new HubStore({ transport: t.transport, ...FAST });
  setHubDataSource(createLiveHubData(store), store);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  store.start();
  await until(() => store.getSnapshot().status === "ready", "ready");
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await new Promise((r) => setTimeout(r, 20));
  store.stop();
  setHubDataSource(undefined);
});

/** The interview is already answered: the preview card shows (the interview itself: projectDraft.test.ts). */
function answered(name: string) {
  saveProjectDraft({
    name, started: true, tpl: "product-saas", addon: false, oneLine: "A cosy farming game for the Mac notch",
    lines: [{ from: "cos", text: `Let's set up ${name}.` }, { from: "ash", text: "A cosy farming game for the Mac notch" }, { from: "cos", text: "Here's how it will look." }],
  });
}

describe("New project", () => {
  it("r61: a draft on the strip can be discarded from its menu, after one confirm with Cancel focused (\"Draft: kids maths\" was stuck)", async () => {
    answered("kids maths");
    act(() => root.render(strip()));
    await until(() => q("[data-hub-project-draft]"), "draft tile");
    act(() => (q("[data-hub-project-draft] [data-project-more]") as HTMLButtonElement).click());
    await until(() => dq("[data-hub-draft-discard]"), "draft menu");
    act(() => dq("[data-hub-draft-discard]")!.click());
    await until(() => dq("[data-hub-draft-discard-confirm]"), "confirm");
    expect(document.activeElement?.hasAttribute("data-hub-draft-discard-cancel")).toBe(true);
    expect(projectDraft()?.name).toBe("kids maths");
    act(() => dq("[data-hub-draft-discard-yes]")!.click());
    await until(() => !q("[data-hub-project-draft]"), "draft gone from the strip");
    expect(projectDraft()).toBeNull();
    expect(localStorage.getItem("monocode:hub-project-draft")).toBeNull();
  });

  it("ends on a preview that says what Create makes, and nothing is made before Create", async () => {
    answered("Moonrise Farm");
    act(() => root.render(createElement(NewProjectView)));
    await until(() => q("[data-hub-new-project-preview]"), "preview card");
    const card = q("[data-hub-new-project-preview]")!.textContent!;
    expect(card).toContain("A new folder at ~/Projects/moonrise-farm: a git repo with a README, never pushed");
    expect(card).toContain("Its own memory. Nothing from your other projects comes with it.");
    expect(q("[data-hub-new-project-team]")?.textContent).toContain("Moonrise lead, its own lead");
    expect(container.querySelectorAll("[data-hub-new-project-shape]")).toHaveLength(14);
    expect(q('[data-hub-new-project-shape="rocket"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-hub-new-project-shape="ghost"]')).toBeNull();
    expect(calls("project-create")).toBe(0);
  });

  it("Create makes the project in the local store, seeds its Lead, joins the strip and opens it", async () => {
    answered("Moonrise Farm");
    act(() => root.render(createElement("div", null, strip(), createElement(NewProjectView))));
    await until(() => q("[data-hub-new-project-preview]"), "preview card");
    act(() => q('[data-hub-new-project-shape="heart"]')!.click());
    await act(async () => q("[data-hub-create-project]")!.click());
    await until(async () => (await kept()).some((p) => p.id === "moonrise-farm"), "made");
    expect((await kept()).find((p) => p.id === "moonrise-farm")).toMatchObject({
      name: "Moonrise Farm", folder: "/Users/example/Projects/moonrise-farm", iconShape: "heart",
    });
    await until(() => stripLabels().includes("Moonrise"), "on the strip");
    expect(stripLabels().slice(-1)).toEqual(["Moonrise"]);
    // Its Lead: a Mono of its own, tied to the folder, recorded as the Lead.
    expect(findMono("moonrise-farm-lead")).toMatchObject({ name: "Moonrise lead", projects: ["/Users/example/Projects/moonrise-farm"] });
    expect(leadFor("moonrise-farm-lead")?.projectId).toBe("moonrise-farm");
    await until(async () => (await t.state()).memberships.some((m) => m.monoId === "moonrise-farm-lead" && m.role === "lead"), "registered as Lead");
    expect(templateOf("moonrise-farm").id).toBe("product-saas");
    expect(projectDraft()).toBeNull();
    expect(JSON.parse(localStorage.getItem("monocode:hub-nav")!)).toEqual({ project: "moonrise-farm", item: "coding-team" });
  });

  it("WP-137: made while this window shows only one group, the project joins that group and shows on the strip", async () => {
    localStorage.setItem("monocode.projectGroups", JSON.stringify([{ id: "g1", name: "Side", collapsed: false }]));
    localStorage.setItem("monocode.projectGroupAssignments", JSON.stringify({ "hub-project:nibbii": "g1" }));
    sessionStorage.setItem("hivra.stripGroupFilter", "g1");
    answered("Moonrise Farm");
    act(() => root.render(createElement("div", null, strip(), createElement(NewProjectView))));
    await until(() => q("[data-hub-new-project-preview]"), "preview card");
    expect(stripLabels()).toEqual(["Home", "Autopilot", "Side", "Nibbii", "Draft"]);
    await act(async () => q("[data-hub-create-project]")!.click());
    await until(() => stripLabels().includes("Moonrise"), "on the strip");
    expect(stripLabels()).toEqual(["Home", "Autopilot", "Side", "Nibbii", "Moonrise"]);
    expect(sessionStorage.getItem("hivra.stripGroupFilter")).toBe("g1");
    expect(JSON.parse(localStorage.getItem("monocode.projectGroupAssignments")!)).toEqual({
      "hub-project:nibbii": "g1",
      "hub-project:moonrise-farm": "g1",
    });
  });

  it("'No code' makes a project without a folder; a clashing name is refused in place and nothing changes", async () => {
    answered("Hivra");
    act(() => root.render(createElement(NewProjectView)));
    await until(() => q("[data-hub-new-project-preview]"), "preview card");
    await act(async () => q("[data-hub-create-project]")!.click());
    await until(() => q("[data-hub-new-project-problem]"), "refusal");
    expect(q("[data-hub-new-project-problem]")?.textContent).toBe("There is already a project called Hivra.");
    expect(await kept()).toHaveLength(4);
    expect(projectDraft()?.name).toBe("Hivra"); // the chat is kept

    act(() => root.unmount());
    root = createRoot(container);
    answered("Quiet Notes");
    act(() => root.render(createElement(NewProjectView)));
    await until(() => q("[data-hub-new-project-preview]"), "preview card");
    act(() => (q('[data-hub-new-project-code-choice="none"]') as HTMLInputElement).click());
    await act(async () => q("[data-hub-create-project]")!.click());
    await until(async () => (await kept()).some((p) => p.id === "quiet-notes"), "made");
    expect((await kept()).find((p) => p.id === "quiet-notes")?.folder).toBeNull();
  });
});

describe("a project's menu", () => {
  it("Rename goes to the local store and the strip follows; a name another project has is refused in place", async () => {
    act(() => root.render(createElement("div", null, strip(), createElement(ProjectMenu, { project: project("nibbii"), anchor: { x: 10, y: 10 }, onClose: () => undefined }))));
    act(() => (document.querySelector('[data-project-menu-item="Rename"]') as HTMLElement).click());
    const input = document.querySelector('[aria-label="Project name"]') as HTMLInputElement;
    type(input, "Hivra");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await until(() => document.querySelector("[data-project-rename-problem]"), "refusal");
    expect(document.querySelector("[data-project-rename-problem]")?.textContent).toBe('"Hivra" already means Hivra (hivra); pick another name');
    type(input, "Nibbii Pet");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await until(async () => (await kept()).find((p) => p.id === "nibbii")?.name === "Nibbii Pet", "renamed");
    await until(() => project("nibbii").name === "Nibbii Pet", "read back");
  });

  it("the shape picker offers the fourteen shapes (no ghost) and sets the chosen one there", async () => {
    act(() => root.render(createElement("div", null, strip(), createElement(ProjectMenu, { project: project("hivra"), anchor: { x: 10, y: 10 }, onClose: () => undefined }))));
    act(() => (document.querySelector('[data-project-menu-item="Change icon"]') as HTMLElement).click());
    const choices = [...document.querySelectorAll("[data-project-shape-choice]")].map((b) => b.getAttribute("data-project-shape-choice"));
    expect(choices).toEqual(["gamepad", "sparkles", "palette", "gauge", "folder", "code", "rocket", "chart", "briefcase", "megaphone", "book", "heart", "globe", "bolt"]);
    await act(async () => (document.querySelector('[data-project-shape-choice="megaphone"]') as HTMLElement).click());
    await until(async () => (await kept()).find((p) => p.id === "hivra")?.iconShape === "megaphone", "shape kept");
    await until(() => q('button[aria-label^="Hivra"] [data-project-shape="megaphone"]'), "strip shows the shape");
  });

  it("Change icon → Upload image… puts the picked image on the strip and the rail, and it stays after a relaunch (G3)", async () => {
    const picked: string[] = [];
    setProjectFileActions({
      showFolder: async () => undefined,
      pickImage: async (id) => (picked.push(id), { src: "asset://localhost/hub-hivra-logo.png", path: "/data/logos/hub-hivra-logo.png" }),
    });
    const rail = () => createElement(HubProjectItems, { selection: { project: "hivra", item: "inbox" }, onPick: () => undefined });
    act(() => root.render(createElement("div", null, strip(), rail(), createElement(ProjectMenu, { project: project("hivra"), anchor: { x: 10, y: 10 }, onClose: () => undefined }))));
    act(() => (document.querySelector('[data-project-menu-item="Change icon"]') as HTMLElement).click());
    await act(async () => (document.querySelector("[data-project-upload]") as HTMLElement).click());
    expect(picked).toEqual(["hivra"]);
    const images = () => [...container.querySelectorAll<HTMLImageElement>('[data-project-glyph="image"]')].map((i) => i.getAttribute("src"));
    await until(() => images().length >= 2, "image on the strip and the rail");
    expect(q('button[aria-label^="Hivra"] [data-project-glyph="image"]')?.getAttribute("src")).toBe("asset://localhost/hub-hivra-logo.png");
    expect(q('[data-hub-project-header] [data-project-glyph="image"]')?.getAttribute("src")).toBe("asset://localhost/hub-hivra-logo.png");
    // A relaunch: everything unmounted and drawn again from what this Mac kept.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement("div", null, strip(), rail())));
    await until(() => images().length >= 2, "image after a relaunch");
    expect(images().every((src) => src === "asset://localhost/hub-hivra-logo.png")).toBe(true);
    expect(JSON.parse(localStorage.getItem("monocode:hub-project-prefs")!).icons.hivra).toMatchObject({ kind: "image", src: "asset://localhost/hub-hivra-logo.png" });
  });

  it("Remove from hub says nothing is deleted, archives it, and Undo brings it back", async () => {
    act(() => root.render(createElement("div", null, strip(), createElement(RemoveFromHub, { project: project("nibbii"), anchor: { x: 10, y: 10 }, onClose: () => undefined }))));
    await until(() => document.querySelector("[data-remove-open]"), "open counts");
    expect(document.querySelector("[data-remove-open]")?.textContent).toContain("Nothing is deleted, and you can bring it back.");
    expect((await kept()).find((p) => p.id === "nibbii")?.archived).toBeFalsy(); // asking changed nothing
    await act(async () => (document.querySelector("[data-project-remove]") as HTMLElement).click());
    await until(async () => (await kept()).find((p) => p.id === "nibbii")?.archived === true, "archived");
    await until(() => !stripLabels().includes("Nibbii"), "off the strip");
    await act(async () => pendingUndo()!.undo());
    await until(() => stripLabels().includes("Nibbii"), "back on the strip");
    expect((await kept()).find((p) => p.id === "nibbii")?.archived).toBe(false);
  });

  it("names Ash gave projects on this Mac before are kept in the local store once, then dropped here", async () => {
    localStorage.setItem("monocode:hub-project-prefs", JSON.stringify({ names: { "vg-game": "EXO game", hivra: "Nibbii" }, order: [], hidden: [], icons: {} }));
    expect(await moveLocalNamesToAshOs()).toBe(1);
    expect((await kept()).find((p) => p.id === "vg-game")?.name).toBe("EXO game");
    // A clash stays local (and still shows).
    expect(JSON.parse(localStorage.getItem("monocode:hub-project-prefs")!).names).toEqual({ hivra: "Nibbii" });
    expect(await moveLocalNamesToAshOs()).toBe(0);
  });
});
