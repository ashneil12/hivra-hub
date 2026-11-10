// @vitest-environment happy-dom
// WP-137: groups on the project strip and "Show only this group". The strip with no groups is today's strip; a group is
// made from a project's menu; the filter is a second, explicit action from the group's heading; projects it hides come
// back in their slots; a remount (a reload) keeps this window's filter.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localTestHub } from "../../../dev/hubTestTransport";
import { setHubDataSource } from "../model/hubData";
import { HubStore } from "../model/hubStore";
import { createLiveHubData } from "../model/liveHubData";
import { ProjectStrip } from "./ProjectStrip";

const FAST = { coalesceMs: 5, minGapMs: 0, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let store: HubStore;
let root: Root;
let container: HTMLElement;
const picked: string[] = [];

async function until(read: () => boolean) {
  for (let i = 0; i < 80 && !read(); i++) await act(async () => new Promise((r) => setTimeout(r, 15)));
  if (!read()) throw new Error("timed out waiting for the strip");
}

/** The strip's project tiles, top to bottom, by name. */
const tiles = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
    .map((b) => b.getAttribute("aria-label") ?? "")
    .filter((label) => ["EXO", "Hivra", "Nibbii", "MonoCode Hub"].includes(label));
const headings = () => [...container.querySelectorAll("[data-strip-group]")].map((el) => el.textContent);
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error("missing element");
  act(() => (el as HTMLElement).click());
};
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text);
const openMenu = (name: string) => click(document.querySelector(`[aria-label="${name} options"][data-project-more]`));

function render() {
  act(() =>
    root.render(
      createElement(ProjectStrip, {
        selection: { project: "hivra", item: "coding-team" },
        onPickProject: (p) => picked.push(p.id),
        onCreateProject: () => undefined,
      }),
    ),
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  sessionStorage.clear();
  picked.length = 0;
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

it("with no groups the strip is exactly the saved order, with no headings and no filter", async () => {
  render();
  await until(() => tiles().length === 4);
  expect(tiles()).toEqual(["EXO", "Hivra", "Nibbii", "MonoCode Hub"]);
  expect(headings()).toEqual([]);
  expect(container.querySelector("[data-strip-show-all]")).toBeNull();
});

it("makes a group from a project's menu, filters to it only when asked, and puts the others back in their slots", async () => {
  render();
  await until(() => tiles().length === 4);

  // Nibbii, then Hub, into a new group "Side".
  openMenu("Nibbii");
  click(byText("[data-project-menu-item]", "Group"));
  click(document.querySelector("[data-project-group-new]"));
  const input = document.querySelector<HTMLInputElement>("[data-project-group-new-name]")!;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "Side");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await until(() => headings().length === 1);
  openMenu("MonoCode Hub");
  click(byText("[data-project-menu-item]", "Group"));
  click(document.querySelector('[data-project-group-choice="Side"]'));

  // Loose projects first, then the group under its heading; nothing else moved.
  await until(() => tiles().join() === "EXO,Hivra,Nibbii,MonoCode Hub");
  expect(headings()).toEqual(["Side"]);
  const section = container.querySelector("[data-strip-group-section]")!;
  expect(section.getAttribute("aria-label")).toBe("Side group");
  expect([...section.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label"))).toContain("Nibbii");
  // Making a group and choosing it did not turn the filter on.
  expect(sessionStorage.getItem("hivra.stripGroupFilter")).toBeNull();

  // The filter is the heading menu's own item.
  click(container.querySelector("[data-strip-group]"));
  const filterItem = document.querySelector('[data-strip-group-item="filter"]')!;
  expect(filterItem.textContent).toBe("Show only this group");
  click(filterItem);
  await until(() => tiles().length === 2);
  expect(tiles()).toEqual(["Nibbii", "MonoCode Hub"]);
  expect(container.querySelector("[data-strip-show-all]")?.textContent).toBe("Show all");
  // No project was opened by any of this.
  expect(picked).toEqual([]);

  // A remount (a reload of this window) keeps it.
  act(() => root.unmount());
  root = createRoot(container);
  render();
  await until(() => tiles().length === 2);
  expect(tiles()).toEqual(["Nibbii", "MonoCode Hub"]);

  // Show all: every project back in the same slot.
  click(container.querySelector("[data-strip-show-all]"));
  await until(() => tiles().length === 4);
  expect(tiles()).toEqual(["EXO", "Hivra", "Nibbii", "MonoCode Hub"]);
  expect(sessionStorage.getItem("hivra.stripGroupFilter")).toBeNull();
});

it("deleting a group asks first, then leaves its projects on the strip", async () => {
  localStorage.setItem("monocode.projectGroups", JSON.stringify([{ id: "g1", name: "Side", collapsed: false }]));
  localStorage.setItem("monocode.projectGroupAssignments", JSON.stringify({ "hub-project:vg-game": "g1" }));
  render();
  await until(() => headings().length === 1 && tiles().length === 4);
  expect(tiles()).toEqual(["Hivra", "Nibbii", "MonoCode Hub", "EXO"]);
  click(container.querySelector("[data-strip-group]"));
  click(document.querySelector('[data-strip-group-item="delete"]'));
  expect(document.querySelector("[data-strip-group-delete-confirm]")?.textContent).toContain(
    'Delete the group "Side"? Its projects stay on the strip.',
  );
  click(document.querySelector("[data-strip-group-delete-yes]"));
  await until(() => headings().length === 0);
  expect(tiles()).toEqual(["EXO", "Hivra", "Nibbii", "MonoCode Hub"]);
});

it("a stored filter naming a group that is gone shows the full strip", async () => {
  sessionStorage.setItem("hivra.stripGroupFilter", "g-gone");
  render();
  await until(() => tiles().length === 4);
  expect(tiles()).toEqual(["EXO", "Hivra", "Nibbii", "MonoCode Hub"]);
  expect(container.querySelector("[data-strip-show-all]")).toBeNull();
});

const seedGroups = (groups: { id: string; name: string }[], assignments: Record<string, string>) => {
  localStorage.setItem("monocode.projectGroups", JSON.stringify(groups.map((g) => ({ ...g, collapsed: false }))));
  localStorage.setItem("monocode.projectGroupAssignments", JSON.stringify(assignments));
};
const menuItems = () => [...document.querySelectorAll("[data-project-menu-item]")].map((el) => el.textContent);
const closeMenu = () => act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

it("Move up / Move down trade places within the project's own section, and show only where there is a neighbour", async () => {
  // Saved order EXO, Hivra, Nibbii, Hub; drawn EXO, Nibbii | Side: Hivra, Hub.
  seedGroups([{ id: "g1", name: "Side" }], { "hub-project:hivra": "g1", "hub-project:hub": "g1" });
  render();
  await until(() => headings().length === 1 && tiles().length === 4);
  expect(tiles()).toEqual(["EXO", "Nibbii", "Hivra", "MonoCode Hub"]);

  // Hub, last in Side: up only. In the saved order its neighbour above is Nibbii, which sits in another section.
  openMenu("MonoCode Hub");
  expect(menuItems()).toContain("Move up");
  expect(menuItems()).not.toContain("Move down");
  click(byText("[data-project-menu-item]", "Move up"));
  await until(() => tiles().join() === "EXO,Nibbii,MonoCode Hub,Hivra");
  expect(headings()).toEqual(["Side"]);

  // Hivra is now last in Side; EXO is first of the projects in no group, Nibbii last.
  openMenu("Hivra");
  expect(menuItems().filter((label) => label?.startsWith("Move"))).toEqual(["Move up"]);
  closeMenu();
  openMenu("EXO");
  expect(menuItems().filter((label) => label?.startsWith("Move"))).toEqual(["Move down"]);
  closeMenu();
  openMenu("Nibbii");
  expect(menuItems().filter((label) => label?.startsWith("Move"))).toEqual(["Move up"]);
  click(byText("[data-project-menu-item]", "Move up"));
  await until(() => tiles().join() === "Nibbii,EXO,MonoCode Hub,Hivra");
});

it("with the filter on, moving a shown project to No group turns the filter off and the project stays on the strip", async () => {
  seedGroups([{ id: "g1", name: "Side" }], { "hub-project:nibbii": "g1", "hub-project:hub": "g1" });
  sessionStorage.setItem("hivra.stripGroupFilter", "g1");
  render();
  await until(() => tiles().length === 2);
  expect(tiles()).toEqual(["Nibbii", "MonoCode Hub"]);
  openMenu("MonoCode Hub");
  click(byText("[data-project-menu-item]", "Group"));
  click(document.querySelector('[data-project-group-choice=""]'));
  await until(() => tiles().length === 4);
  expect(tiles()).toEqual(["EXO", "Hivra", "MonoCode Hub", "Nibbii"]);
  expect(sessionStorage.getItem("hivra.stripGroupFilter")).toBeNull();
  expect(container.querySelector("[data-strip-show-all]")).toBeNull();
});

it("a group with no project on the strip (a classic rail folder group) gets no heading unless the filter is on it", async () => {
  seedGroups(
    [{ id: "g-folders", name: "Folders" }, { id: "g1", name: "Side" }],
    { "/Users/example/code": "g-folders", "hub-project:vg-game": "g1" },
  );
  render();
  await until(() => headings().length === 1 && tiles().length === 4);
  expect(headings()).toEqual(["Side"]);

  act(() => root.unmount());
  root = createRoot(container);
  sessionStorage.setItem("hivra.stripGroupFilter", "g-folders");
  render();
  await until(() => container.querySelector("[data-strip-show-all]") !== null);
  expect(headings()).toEqual(["Folders"]);
  expect(tiles()).toEqual([]);
});

it("a rename or delete box on a group another window deleted says the group is gone and closes the box", async () => {
  seedGroups([{ id: "g1", name: "Side" }], { "hub-project:vg-game": "g1" });
  render();
  await until(() => headings().length === 1);
  // Rename: the box is open here when the other window deletes the group (its write sends no event here).
  click(container.querySelector("[data-strip-group]"));
  click(document.querySelector('[data-strip-group-item="rename"]'));
  const input = document.querySelector<HTMLInputElement>("[data-strip-group-rename] input")!;
  localStorage.setItem("monocode.projectGroups", "[]");
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "Renamed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(document.querySelector("[data-strip-group-rename]")).toBeNull();
  expect(document.querySelector("[data-strip-group-gone]")?.textContent).toContain(
    "This group is gone: it was deleted in another window.",
  );
  expect(document.querySelector("[data-strip-group-gone]")?.textContent).not.toMatch(/try again/);
  await until(() => headings().length === 0);
  click(byText("[data-strip-group-gone] button", "OK"));
  expect(document.querySelector("[data-strip-group-gone]")).toBeNull();
  expect(localStorage.getItem("monocode.projectGroups")).toBe("[]");

  // Delete: the same.
  act(() => root.unmount());
  root = createRoot(container);
  seedGroups([{ id: "g1", name: "Side" }], { "hub-project:vg-game": "g1" });
  render();
  await until(() => headings().length === 1);
  click(container.querySelector("[data-strip-group]"));
  click(document.querySelector('[data-strip-group-item="delete"]'));
  localStorage.setItem("monocode.projectGroups", "[]");
  click(document.querySelector("[data-strip-group-delete-yes]"));
  expect(document.querySelector("[data-strip-group-delete-confirm]")).toBeNull();
  expect(document.querySelector("[data-strip-group-gone]")?.textContent).toContain("This group is gone");
});
