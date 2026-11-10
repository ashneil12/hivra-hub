// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHOW_ONLY_GROUP_LABEL, saveShowOnlyGroup } from "../../settings/model/displayPrefs";
import { GroupFilterRail, type GroupFilterItem } from "./GroupFilterRail";

const pinned: GroupFilterItem[] = [
  { id: "pin-old", label: "Pin old", groupId: "work" },
  { id: "pin-new", label: "Pin new", groupId: "home" },
];

const groups = [
  {
    id: "work",
    name: "Work",
    items: [
      { id: "alpha", label: "Alpha", groupId: "work" },
      { id: "beta", label: "Beta", groupId: "work" },
    ] as GroupFilterItem[],
  },
  {
    id: "home",
    name: "Home",
    items: [{ id: "delta", label: "Delta", groupId: "home" }] as GroupFilterItem[],
  },
  { id: "empty", name: "Empty", items: [] as GroupFilterItem[] },
];

const ungrouped: GroupFilterItem[] = [{ id: "gamma", label: "Gamma", groupId: null }];

const fullOrder = "pin-old pin-new alpha beta delta gamma";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  saveShowOnlyGroup(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  saveShowOnlyGroup(false);
  localStorage.clear();
});

function order(): string {
  return container.querySelector("[data-rail-order]")?.getAttribute("data-rail-order") ?? "";
}

function click(selector: string) {
  const node = container.querySelector<HTMLButtonElement>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  act(() => node.click());
}

describe("group filter rail", () => {
  it("stays the full rail until the setting is on and the group is chosen", () => {
    act(() => {
      root.render(
        createElement(GroupFilterRail, { pinned, groups, ungrouped }),
      );
    });
    expect(order()).toBe(fullOrder);
    expect(container.querySelector("[data-show-only-group]")).toBeNull();
    expect(container.textContent).not.toMatch(/[—–]/);

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Expand Work"]')!.click();
    });
    expect(order()).toBe(fullOrder);
    expect(container.querySelector("[data-group-filter]")?.getAttribute("data-group-filter")).toBe("off");
  });

  it("filters one rail and leaves the other window alone", () => {
    function Pair() {
      return createElement(
        "div",
        null,
        createElement("button", {
          type: "button",
          role: "switch",
          "aria-label": SHOW_ONLY_GROUP_LABEL,
          onClick: () => saveShowOnlyGroup(true),
        }),
        createElement("div", { "data-window": "left" }, createElement(GroupFilterRail, { pinned, groups, ungrouped })),
        createElement("div", { "data-window": "right" }, createElement(GroupFilterRail, { pinned, groups, ungrouped })),
      );
    }
    act(() => root.render(createElement(Pair)));
    act(() => {
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    const left = container.querySelector("[data-window=left]")!;
    const right = container.querySelector("[data-window=right]")!;
    expect(left.querySelectorAll("[data-show-only-group]").length).toBe(3);
    expect(right.querySelector("[data-rail-order]")?.getAttribute("data-rail-order")).toBe(fullOrder);

    act(() => {
      left.querySelector<HTMLButtonElement>('[data-show-only-group="work"]')!.click();
    });
    expect(left.querySelector("[data-rail-order]")?.getAttribute("data-rail-order")).toBe("pin-old alpha beta");
    expect(left.querySelector("[data-group-filter]")?.getAttribute("data-group-filter")).toBe("on");
    expect(right.querySelector("[data-rail-order]")?.getAttribute("data-rail-order")).toBe(fullOrder);
    expect(right.querySelector("[data-group-filter]")?.getAttribute("data-group-filter")).toBe("off");
    expect(localStorage.getItem("monocode.projectRailOrder")).toBeNull();
    expect(localStorage.getItem("monocode.projectGroups")).toBeNull();
  });

  it("restores the same order, and a missing group is not an empty rail", () => {
    function Harness({ dropWork }: { dropWork: boolean }) {
      const listed = dropWork ? groups.filter((group) => group.id !== "work") : groups;
      const loose: GroupFilterItem[] = dropWork
        ? [...groups[0].items, ...ungrouped]
        : ungrouped;
      return createElement(
        "div",
        null,
        createElement(GroupFilterRail, { pinned, groups: listed, ungrouped: loose }),
      ) as ReactNode;
    }
    saveShowOnlyGroup(true);
    act(() => root.render(createElement(Harness, { dropWork: false })));
    click('[data-show-only-group="work"]');
    expect(order()).toBe("pin-old alpha beta");

    click("[data-show-every-project]");
    expect(order()).toBe(fullOrder);
    expect(container.querySelector("[data-group-filter]")?.getAttribute("data-group-filter")).toBe("off");

    click('[data-show-only-group="empty"]');
    expect(order()).toBe("");
    expect(container.querySelector("[data-group-empty=empty]")?.textContent).toBe("No projects in this group.");
    expect(container.querySelector("[data-group-filter]")?.getAttribute("data-group-filter")).toBe("on");

    click("[data-show-every-project]");
    click('[data-show-only-group="work"]');
    act(() => root.render(createElement(Harness, { dropWork: true })));
    expect(container.querySelector("[data-group-filter-note]")?.textContent).toBe("That group is no longer there.");
    expect(container.querySelector("[data-group-filter]")?.getAttribute("data-group-filter")).toBe("unavailable");
    expect(container.querySelector("[data-project=alpha]")).not.toBeNull();
    expect(container.querySelector("[data-project=gamma]")).not.toBeNull();
    expect(order().startsWith("pin-old pin-new")).toBe(true);
  });

  it("drops the filter when the setting turns off", () => {
    saveShowOnlyGroup(true);
    act(() => root.render(createElement(GroupFilterRail, { pinned, groups, ungrouped })));
    click('[data-show-only-group="home"]');
    expect(order()).toBe("pin-new delta");
    act(() => saveShowOnlyGroup(false));
    expect(order()).toBe(fullOrder);
    expect(container.querySelector("[data-show-only-group]")).toBeNull();
    expect(container.querySelector("[data-group-filter]")?.getAttribute("data-group-filter")).toBe("off");
  });
});
