// @vitest-environment happy-dom
// WP-137: the strip's groups and "Show only this group". The rules come from docs/hivra/work/WP-137-workspace-chrome.md.
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadProjectGroupAssignments,
  loadProjectGroups,
  saveProjectGroups,
  type ProjectGroup,
} from "../../projects/model/projectGroups";
import {
  addStripGroup,
  deleteStripGroup,
  distinctGroupName,
  renameStripGroup,
  setStripGroupFilter,
  setStripProjectGroup,
  stripGroupFilter,
  stripGroupKey,
  stripLayout,
} from "./stripGroups";

const p = (id: string) => ({ id });
const PROJECTS = [p("a"), p("b"), p("c"), p("d"), p("e")];
const ids = (list: { id: string }[]) => list.map((x) => x.id);
const work: ProjectGroup = { id: "g-work", name: "Work", collapsed: false };
const games: ProjectGroup = { id: "g-games", name: "Games", collapsed: false };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("stripLayout", () => {
  it("with no groups and no filter is the saved order, untouched", () => {
    const layout = stripLayout(PROJECTS, [], {}, null);
    expect(ids(layout.loose)).toEqual(["a", "b", "c", "d", "e"]);
    expect(layout.groups).toEqual([]);
    expect(layout.filter).toBeNull();
  });

  it("puts grouped projects under their group, each keeping the saved order", () => {
    const assignments = { [stripGroupKey("d")]: work.id, [stripGroupKey("b")]: work.id, [stripGroupKey("c")]: games.id };
    const layout = stripLayout(PROJECTS, [work, games], assignments, null);
    expect(ids(layout.loose)).toEqual(["a", "e"]);
    expect(layout.groups.map((s) => [s.group.id, ids(s.projects)])).toEqual([
      ["g-work", ["b", "d"]],
      ["g-games", ["c"]],
    ]);
  });

  it("the filter shows one group only, and turning it off puts every project back in the same slot", () => {
    const assignments = { [stripGroupKey("b")]: work.id, [stripGroupKey("d")]: work.id };
    const before = stripLayout(PROJECTS, [work, games], assignments, null);
    const on = stripLayout(PROJECTS, [work, games], assignments, work.id);
    expect(on.filter?.id).toBe("g-work");
    expect(on.loose).toEqual([]);
    expect(on.groups.map((s) => [s.group.id, ids(s.projects)])).toEqual([["g-work", ["b", "d"]]]);
    const off = stripLayout(PROJECTS, [work, games], assignments, null);
    expect(off).toEqual(before);
  });

  it("ignores a filter that names a missing group: the full strip, in the saved order", () => {
    const layout = stripLayout(PROJECTS, [work], { [stripGroupKey("a")]: work.id }, "g-gone");
    expect(layout.filter).toBeNull();
    expect(ids(layout.loose)).toEqual(["b", "c", "d", "e"]);
    expect(ids(layout.groups[0].projects)).toEqual(["a"]);
  });

  it("an empty group shows an empty section and pulls nothing in", () => {
    const layout = stripLayout(PROJECTS, [work, games], { [stripGroupKey("a")]: work.id }, games.id);
    expect(layout.groups).toEqual([{ group: games, projects: [] }]);
    expect(layout.loose).toEqual([]);
  });

  it("an assignment to a group that is gone leaves the project loose, in its slot", () => {
    const layout = stripLayout(PROJECTS, [work], { [stripGroupKey("c")]: "g-gone" }, null);
    expect(ids(layout.loose)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("this window's filter", () => {
  it("is off until set, kept in this window's session storage, and never written into the group list", () => {
    saveProjectGroups([work]);
    const groupsBefore = localStorage.getItem("monocode.projectGroups");
    expect(stripGroupFilter()).toBeNull();
    setStripGroupFilter(work.id);
    expect(stripGroupFilter()).toBe(work.id);
    expect(sessionStorage.getItem("hivra.stripGroupFilter")).toBe(work.id);
    expect(localStorage.getItem("monocode.projectGroups")).toBe(groupsBefore);
    expect(Object.keys(localStorage).some((key) => localStorage.getItem(key) === work.id)).toBe(false);
    setStripGroupFilter(null);
    expect(stripGroupFilter()).toBeNull();
    expect(localStorage.getItem("monocode.projectGroups")).toBe(groupsBefore);
  });
});

describe("writes to the shared group list", () => {
  it("adds a group and moves the project into it; a blank name is refused", () => {
    expect(addStripGroup([], "   ").result).toBe("refused");
    const { result, group } = addStripGroup([], " Work ", "a");
    expect(result).toBe("ok");
    expect(group?.name).toBe("Work");
    expect(loadProjectGroups().map((g) => g.name)).toEqual(["Work"]);
    expect(loadProjectGroupAssignments()).toEqual({ [stripGroupKey("a")]: group!.id });
  });

  it("gives a second group with the same name a distinct name and its own id", () => {
    const first = addStripGroup([], "Work").group!;
    const second = addStripGroup(loadProjectGroups(), "work").group!;
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe("work 2");
    expect(distinctGroupName([first, second], "Work")).toBe("Work 3");
    // Renaming one to the other's name keeps them apart too.
    expect(renameStripGroup(loadProjectGroups(), second.id, "WORK")).toBe("ok");
    expect(loadProjectGroups().map((g) => g.name)).toEqual(["Work", "WORK 2"]);
  });

  it("drops a write based on a list another window has changed since, so its new group survives", () => {
    saveProjectGroups([work]);
    const seenHere = loadProjectGroups();
    // The other window adds a group.
    saveProjectGroups([...loadProjectGroups(), games]);
    expect(addStripGroup(seenHere, "Later").result).toBe("stale");
    expect(renameStripGroup(seenHere, work.id, "Renamed")).toBe("stale");
    expect(deleteStripGroup(seenHere, work.id)).toBe("stale");
    expect(loadProjectGroups().map((g) => g.id)).toEqual(["g-work", "g-games"]);
    expect(loadProjectGroups()[0].name).toBe("Work");
  });

  it("refuses a blank rename and keeps the old name", () => {
    saveProjectGroups([work]);
    expect(renameStripGroup(loadProjectGroups(), work.id, "  ")).toBe("refused");
    expect(loadProjectGroups()[0].name).toBe("Work");
  });

  it("deleting a group removes the heading only: its projects stay, loose, and this window's filter on it goes off", () => {
    saveProjectGroups([work, games]);
    setStripProjectGroup("a", work.id);
    setStripProjectGroup("c", games.id);
    setStripGroupFilter(work.id);
    expect(deleteStripGroup(loadProjectGroups(), work.id)).toBe("ok");
    expect(loadProjectGroups().map((g) => g.id)).toEqual(["g-games"]);
    expect(loadProjectGroupAssignments()).toEqual({ [stripGroupKey("c")]: games.id });
    expect(stripGroupFilter()).toBeNull();
    const layout = stripLayout(PROJECTS, loadProjectGroups(), loadProjectGroupAssignments(), null);
    expect(ids(layout.loose)).toEqual(["a", "b", "d", "e"]);
  });

  it("moves a project between groups and out of them; a group that is gone is refused", () => {
    saveProjectGroups([work, games]);
    expect(setStripProjectGroup("a", work.id)).toBe("ok");
    expect(setStripProjectGroup("a", games.id)).toBe("ok");
    expect(loadProjectGroupAssignments()).toEqual({ [stripGroupKey("a")]: games.id });
    expect(setStripProjectGroup("a", "g-gone")).toBe("stale");
    expect(setStripProjectGroup("a", null)).toBe("ok");
    expect(loadProjectGroupAssignments()).toEqual({});
  });

  it("keeps a folder path's rail assignment beside a strip project's", () => {
    saveProjectGroups([work]);
    localStorage.setItem("monocode.projectGroupAssignments", JSON.stringify({ "/Users/example/code": work.id }));
    setStripProjectGroup("a", work.id);
    expect(loadProjectGroupAssignments()).toEqual({ "/Users/example/code": work.id, [stripGroupKey("a")]: work.id });
  });
});
