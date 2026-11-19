// @vitest-environment happy-dom
// WP-137: the strip's groups and "Show only this group". The rules come from docs/hivra/work/WP-137-workspace-chrome.md.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  groupWriteProblem,
  joinShownStripGroup,
  renameStripGroup,
  setStripGroupFilter,
  setStripProjectGroup,
  stripGroupFilter,
  stripGroupKey,
  stripLayout,
  stripSectionNeighbour,
} from "./stripGroups";
import { swapProjects } from "./projectPrefs";

const p = (id: string) => ({ id });
const PROJECTS = [p("a"), p("b"), p("c"), p("d"), p("e")];
const ids = (list: { id: string }[]) => list.map((x) => x.id);
const work: ProjectGroup = { id: "g-work", name: "Work", collapsed: false };
const games: ProjectGroup = { id: "g-games", name: "Games", collapsed: false };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
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

  it("the group the filter is on keeps its heading when empty, and pulls nothing in", () => {
    const layout = stripLayout(PROJECTS, [work, games], { [stripGroupKey("a")]: work.id }, games.id);
    expect(layout.groups).toEqual([{ group: games, projects: [] }]);
    expect(layout.loose).toEqual([]);
  });

  it("a group with no project on the strip gets no heading (the classic rail's folder groups share the list)", () => {
    const folders: ProjectGroup = { id: "g-folders", name: "Folders", collapsed: false };
    const assignments = { "/Users/example/code": folders.id, [stripGroupKey("b")]: work.id };
    const layout = stripLayout(PROJECTS, [folders, work, games], assignments, null);
    expect(layout.groups.map((s) => [s.group.id, ids(s.projects)])).toEqual([["g-work", ["b"]]]);
    expect(ids(layout.loose)).toEqual(["a", "c", "d", "e"]);
    // Only folder groups: the strip is today's strip, with no heading.
    const onlyFolders = stripLayout(PROJECTS, [folders], { "/Users/example/code": folders.id }, null);
    expect(onlyFolders).toEqual(stripLayout(PROJECTS, [], {}, null));
  });

  it("an assignment to a group that is gone leaves the project loose, in its slot", () => {
    const layout = stripLayout(PROJECTS, [work], { [stripGroupKey("c")]: "g-gone" }, null);
    expect(ids(layout.loose)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("Move up / Move down", () => {
  const assignments = { [stripGroupKey("b")]: work.id, [stripGroupKey("d")]: work.id, [stripGroupKey("c")]: games.id };
  const layout = stripLayout(PROJECTS, [work, games], assignments, null);
  const near = (id: string, by: -1 | 1) => stripSectionNeighbour(layout, id, by)?.id;

  it("trade places with the neighbour in the same section as the strip draws it, not in the full saved order", () => {
    // Drawn: a e | Work: b d | Games: c. In the saved order d's neighbour above is c (another group).
    expect(near("d", -1)).toBe("b");
    expect(near("b", 1)).toBe("d");
    expect(near("a", 1)).toBe("e");
    expect(near("e", -1)).toBe("a");
  });

  it("have no neighbour at either end of a section, so the menu leaves them out", () => {
    expect(near("a", -1)).toBeUndefined();
    expect(near("e", 1)).toBeUndefined();
    expect(near("b", -1)).toBeUndefined();
    expect(near("d", 1)).toBeUndefined();
    expect(near("c", -1)).toBeUndefined();
    expect(near("c", 1)).toBeUndefined();
  });

  it("with the filter on, a project the filter hides has no neighbour", () => {
    const filtered = stripLayout(PROJECTS, [work, games], assignments, work.id);
    expect(stripSectionNeighbour(filtered, "d", -1)?.id).toBe("b");
    expect(stripSectionNeighbour(filtered, "a", 1)).toBeUndefined();
  });

  it("a move changes the section it is in and leaves every other project in its slot", () => {
    const order = PROJECTS.map((x) => x.id);
    swapProjects(order, "d", near("d", -1)!);
    const saved = JSON.parse(localStorage.getItem("monocode:hub-project-prefs") ?? "null") as { order: string[] } | null;
    const next = (saved?.order ?? []).map(p);
    expect(ids(next)).toEqual(["a", "d", "c", "b", "e"]);
    const after = stripLayout(next, [work, games], assignments, null);
    expect(ids(after.loose)).toEqual(["a", "e"]);
    expect(after.groups.map((s) => [s.group.id, ids(s.projects)])).toEqual([
      ["g-work", ["d", "b"]],
      ["g-games", ["c"]],
    ]);
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

  it("a rename or delete of a group another window deleted says it is gone, not try again, however fresh the list", () => {
    saveProjectGroups([work, games]);
    const seenHere = loadProjectGroups();
    // The other window deletes Work while this window's rename or delete box is open.
    saveProjectGroups([games]);
    expect(renameStripGroup(seenHere, work.id, "Renamed")).toBe("gone");
    expect(deleteStripGroup(seenHere, work.id)).toBe("gone");
    // Trying again on the list as it is now can't reach it either.
    expect(renameStripGroup(loadProjectGroups(), work.id, "Renamed")).toBe("gone");
    expect(deleteStripGroup(loadProjectGroups(), work.id)).toBe("gone");
    expect(loadProjectGroups()).toEqual([games]);
    expect(groupWriteProblem("gone")).toBe("This group is gone: it was deleted in another window.");
    expect(groupWriteProblem("gone")).not.toMatch(/try again/);
  });

  it("keeps a folder path's rail assignment beside a strip project's", () => {
    saveProjectGroups([work]);
    localStorage.setItem("monocode.projectGroupAssignments", JSON.stringify({ "/Users/example/code": work.id }));
    setStripProjectGroup("a", work.id);
    expect(loadProjectGroupAssignments()).toEqual({ "/Users/example/code": work.id, [stripGroupKey("a")]: work.id });
  });
});

describe("the filter and a project leaving or joining the group it shows", () => {
  const shown = (filterId: string | null) =>
    stripLayout(PROJECTS, loadProjectGroups(), loadProjectGroupAssignments(), filterId);
  const visible = () => {
    const layout = shown(stripGroupFilter());
    return [...ids(layout.loose), ...layout.groups.flatMap((section) => ids(section.projects))];
  };

  beforeEach(() => {
    saveProjectGroups([work, games]);
    setStripProjectGroup("a", work.id);
    setStripProjectGroup("b", work.id);
    setStripProjectGroup("c", games.id);
    setStripGroupFilter(work.id);
  });

  it("moving a shown project to No group turns the filter off, so it stays on the strip", () => {
    expect(setStripProjectGroup("a", null)).toBe("ok");
    expect(stripGroupFilter()).toBeNull();
    expect(visible()).toContain("a");
  });

  it("moving a shown project to another group turns the filter off too", () => {
    expect(setStripProjectGroup("b", games.id)).toBe("ok");
    expect(stripGroupFilter()).toBeNull();
    expect(visible()).toContain("b");
  });

  it("moving a shown project into a new group turns the filter off too", () => {
    const { result, group } = addStripGroup(loadProjectGroups(), "Later", "a");
    expect(result).toBe("ok");
    expect(stripGroupFilter()).toBeNull();
    expect(stripLayout(PROJECTS, loadProjectGroups(), loadProjectGroupAssignments(), null).groups.map((x) => x.group.id))
      .toContain(group!.id);
    expect(visible()).toContain("a");
  });

  it("a move that keeps the shown group's projects in view leaves the filter on", () => {
    // Into the shown group, and a project the filter already hides moving between other places.
    expect(setStripProjectGroup("d", work.id)).toBe("ok");
    expect(setStripProjectGroup("c", null)).toBe("ok");
    expect(stripGroupFilter()).toBe(work.id);
    expect(visible()).toEqual(["a", "b", "d"]);
  });

  it("a project made while the filter is on joins the shown group and shows", () => {
    const made = [...PROJECTS, p("new")];
    joinShownStripGroup("new");
    expect(stripGroupFilter()).toBe(work.id);
    expect(loadProjectGroupAssignments()[stripGroupKey("new")]).toBe(work.id);
    const layout = stripLayout(made, loadProjectGroups(), loadProjectGroupAssignments(), stripGroupFilter());
    expect(ids(layout.groups[0].projects)).toEqual(["a", "b", "new"]);
  });

  it("a project made with the filter off, or on a group that is gone, joins nothing", () => {
    setStripGroupFilter(null);
    joinShownStripGroup("new");
    setStripGroupFilter("g-gone");
    joinShownStripGroup("new");
    expect(loadProjectGroupAssignments()[stripGroupKey("new")]).toBeUndefined();
  });

  it("a project made while the filter is on, when the group can't be written, turns the filter off instead", () => {
    const real = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => {
        if (key === "monocode.projectGroupAssignments") throw new Error("storage full");
        real.setItem(key, value);
      },
      removeItem: (key: string) => real.removeItem(key),
    });
    joinShownStripGroup("new");
    vi.unstubAllGlobals();
    expect(loadProjectGroupAssignments()[stripGroupKey("new")]).toBeUndefined();
    expect(stripGroupFilter()).toBeNull();
  });
});
