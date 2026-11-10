// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  SHOW_ONLY_GROUP_DESCRIPTION,
  SHOW_ONLY_GROUP_LABEL,
} from "../../settings/model/displayPrefs";
import {
  GROUP_FILTER_EMPTY,
  GROUP_FILTER_MISSING,
  SHOW_EVERY_PROJECT,
  SHOW_ONLY_THIS_GROUP,
  applyGroupFilter,
  groupFilterIsEmpty,
  groupFilterRequest,
  groupFilterState,
  type GroupFilterRail,
} from "./groupFilter";

type Project = { id: string; at: number; groupId?: string };

const groupIdOf = (project: Project) => project.groupId;

function rail(): GroupFilterRail<Project> {
  return {
    pinned: [
      { id: "pin-old", at: 1, groupId: "work" },
      { id: "pin-new", at: 9, groupId: "home" },
    ],
    groups: [
      {
        id: "work",
        items: [
          { id: "alpha", at: 3, groupId: "work" },
          { id: "beta", at: 1, groupId: "work" },
        ],
      },
      {
        id: "home",
        items: [{ id: "delta", at: 2, groupId: "home" }],
      },
      { id: "empty", items: [] },
    ],
    ungrouped: [{ id: "gamma", at: 8 }],
  };
}

const known = ["work", "home", "empty"];

function freeze<T>(value: GroupFilterRail<T>): GroupFilterRail<T> {
  for (const group of value.groups) Object.freeze(group.items);
  Object.freeze(value.groups);
  Object.freeze(value.pinned);
  Object.freeze(value.ungrouped);
  return Object.freeze(value);
}

describe("group filter", () => {
  it("with the setting off, the rail is the same lists in the same order", () => {
    const full = freeze(rail());
    const decision = applyGroupFilter(
      full,
      known,
      groupFilterRequest(false, "work"),
      groupIdOf,
    );
    expect(decision.pinned).toBe(full.pinned);
    expect(decision.groups).toBe(full.groups);
    expect(decision.ungrouped).toBe(full.ungrouped);
    expect(decision.limited).toBe(false);
    expect(decision.unavailable).toBeNull();
    expect(groupFilterState(decision)).toBe("off");
    expect(groupFilterIsEmpty(decision)).toBe(false);
  });

  it("keeps a fixed order and does not sort by update time", () => {
    const full = rail();
    const on = applyGroupFilter(
      full,
      known,
      { enabled: true, groupId: "work" },
      groupIdOf,
    );
    expect(on.limited).toBe(true);
    expect(on.groups.map((group) => group.id)).toEqual(["work"]);
    expect(on.groups[0].items.map((item) => item.id)).toEqual(["alpha", "beta"]);
    expect(on.groups[0].items.map((item) => item.at)).toEqual([3, 1]);
    expect(on.pinned.map((item) => item.id)).toEqual(["pin-old"]);
    expect(on.ungrouped).toEqual([]);
    expect(on.unavailable).toBeNull();

    const off = applyGroupFilter(full, known, { enabled: false, groupId: "work" }, groupIdOf);
    expect(off.pinned.map((item) => item.id)).toEqual(["pin-old", "pin-new"]);
    expect(off.groups.map((group) => group.id)).toEqual(["work", "home", "empty"]);
    expect(off.groups[0].items.map((item) => item.id)).toEqual(["alpha", "beta"]);
    expect(off.ungrouped.map((item) => item.id)).toEqual(["gamma"]);
  });

  it("does not swap two pins, and hidden projects return to their slots", () => {
    const full = freeze(rail());
    const work = applyGroupFilter(full, known, { enabled: true, groupId: "work" }, groupIdOf);
    expect(work.pinned.map((item) => item.id)).toEqual(["pin-old"]);
    const home = applyGroupFilter(full, known, { enabled: true, groupId: "home" }, groupIdOf);
    expect(home.pinned.map((item) => item.id)).toEqual(["pin-new"]);
    expect(home.groups[0].items.map((item) => item.id)).toEqual(["delta"]);

    const restored = applyGroupFilter(full, known, { enabled: true, groupId: null }, groupIdOf);
    expect(restored.pinned).toBe(full.pinned);
    expect(restored.groups).toBe(full.groups);
    expect(restored.ungrouped).toBe(full.ungrouped);
  });

  it("leaves a second window on the full rail", () => {
    const full = rail();
    const left = applyGroupFilter(full, known, { enabled: true, groupId: "work" }, groupIdOf);
    const right = applyGroupFilter(full, known, { enabled: false, groupId: null }, groupIdOf);
    expect(left.limited).toBe(true);
    expect(left.groups.map((group) => group.id)).toEqual(["work"]);
    expect(right.groups).toBe(full.groups);
    expect(right.limited).toBe(false);
  });

  it("shows an empty group without pulling other projects in", () => {
    const full = rail();
    const decision = applyGroupFilter(
      full,
      known,
      { enabled: true, groupId: "empty" },
      groupIdOf,
    );
    expect(decision.limited).toBe(true);
    expect(decision.groups).toEqual([{ id: "empty", items: [] }]);
    expect(decision.pinned).toEqual([]);
    expect(decision.ungrouped).toEqual([]);
    expect(decision.unavailable).toBeNull();
    expect(groupFilterIsEmpty(decision)).toBe(true);
    expect(groupFilterState(decision)).toBe("on");
  });

  it("ignores a missing group and keeps the full rail", () => {
    const full = freeze(rail());
    const decision = applyGroupFilter(
      full,
      known,
      { enabled: true, groupId: "gone" },
      groupIdOf,
    );
    expect(decision.limited).toBe(false);
    expect(decision.unavailable).toBe(GROUP_FILTER_MISSING);
    expect(decision.pinned).toBe(full.pinned);
    expect(decision.groups).toBe(full.groups);
    expect(decision.ungrouped).toBe(full.ungrouped);
    expect(groupFilterState(decision)).toBe("unavailable");
    expect(groupFilterIsEmpty(decision)).toBe(false);
  });

  it("treats a bad request as off, or as no group, never as a successful filter", () => {
    expect(groupFilterRequest(undefined, "work")).toEqual({ enabled: false, groupId: null });
    expect(groupFilterRequest("1", "work")).toEqual({ enabled: false, groupId: null });
    expect(groupFilterRequest(true, "")).toEqual({ enabled: true, groupId: null });
    expect(groupFilterRequest(true, " work")).toEqual({ enabled: true, groupId: null });
    expect(groupFilterRequest(true, "work ")).toEqual({ enabled: true, groupId: null });
    expect(groupFilterRequest(true, 3)).toEqual({ enabled: true, groupId: null });
    expect(groupFilterRequest(true, "work")).toEqual({ enabled: true, groupId: "work" });

    const full = rail();
    for (const request of [
      groupFilterRequest("yes", "work"),
      groupFilterRequest(true, " "),
      groupFilterRequest(true, null),
    ]) {
      const decision = applyGroupFilter(full, known, request, groupIdOf);
      expect(decision.limited).toBe(false);
      expect(decision.unavailable).toBeNull();
      expect(decision.groups).toBe(full.groups);
    }
  });

  it("does not write the group list or the rail order", () => {
    localStorage.setItem("monocode.projectGroups", "[{\"id\":\"work\"}]");
    localStorage.setItem("monocode.projectRailOrder", "[\"pin-old\",\"alpha\"]");
    localStorage.setItem("monocode.projectGroupAssignments", "{\"alpha\":\"work\"}");
    localStorage.setItem("monocode.projectRailPinned", "[\"pin-old\"]");
    const setItem = vi.spyOn(localStorage, "setItem");
    applyGroupFilter(rail(), known, { enabled: true, groupId: "work" }, groupIdOf);
    applyGroupFilter(rail(), known, { enabled: true, groupId: "gone" }, groupIdOf);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem("monocode.projectGroups")).toBe("[{\"id\":\"work\"}]");
    expect(localStorage.getItem("monocode.projectRailOrder")).toBe("[\"pin-old\",\"alpha\"]");
    expect(localStorage.getItem("monocode.projectGroupAssignments")).toBe("{\"alpha\":\"work\"}");
    expect(localStorage.getItem("monocode.projectRailPinned")).toBe("[\"pin-old\"]");
    setItem.mockRestore();
  });

  it("keeps an empty known group that is not already on the rail", () => {
    const full = rail();
    const decision = applyGroupFilter(
      full,
      [...known, "later"],
      { enabled: true, groupId: "later" },
      groupIdOf,
    );
    expect(decision.limited).toBe(true);
    expect(decision.groups).toEqual([{ id: "later", items: [] }]);
    expect(decision.ungrouped).toEqual([]);
    expect(groupFilterIsEmpty(decision)).toBe(true);
  });

  it("uses plain sentences without a dash", () => {
    for (const text of [
      SHOW_ONLY_THIS_GROUP,
      SHOW_EVERY_PROJECT,
      GROUP_FILTER_MISSING,
      GROUP_FILTER_EMPTY,
      SHOW_ONLY_GROUP_LABEL,
      SHOW_ONLY_GROUP_DESCRIPTION,
    ]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text.toLowerCase()).not.toContain("space");
    }
  });
});
