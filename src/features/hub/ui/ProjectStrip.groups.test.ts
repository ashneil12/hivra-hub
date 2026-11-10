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
