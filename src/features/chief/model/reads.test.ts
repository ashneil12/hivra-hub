import { describe, expect, it } from "vitest";
import { copyProjects, pageReadable, readKeys, resolveProject, sameProject, type CopyProject } from "./reads";

const known: CopyProject[] = [
  { id: "crew", name: "Crew", folder: "C:\\work\\crew" },
  { id: "site", name: "Site", folder: "/work/site" },
  { id: "site", name: "Again", folder: "/work/again" },
];

describe("copyProjects", () => {
  it("drops blanks, duplicates, a climb, and a folder that climbs", () => {
    expect(copyProjects([
      { id: " crew ", name: " Crew ", folder: "C:\\work\\crew" },
      { id: "crew", name: "Second" },
      { id: "", name: "No" },
      { id: "../daily", name: "Daily" },
      { id: "site", name: "Site", folder: "..\\secret" },
      { id: 1 as unknown as string, name: "No" },
    ])).toEqual([{ id: "crew", name: "Crew", folder: "C:\\work\\crew" }, { id: "site", name: "Site", folder: null }]);
    expect(copyProjects(undefined)).toEqual([]);
  });
});

describe("resolveProject", () => {
  const projects = copyProjects(known);
  it("matches an id, a Windows folder, or one name, and refuses two or a climb", () => {
    expect(resolveProject("crew", projects)?.id).toBe("crew");
    expect(resolveProject("c:/work/crew", projects)?.id).toBe("crew");
    expect(resolveProject("Site", projects)?.id).toBe("site");
    expect(resolveProject("site", projects)?.id).toBe("site");
    expect(resolveProject("../daily", projects)).toBeUndefined();
    expect(resolveProject("Missing", projects)).toBeUndefined();
    expect(resolveProject("", projects)).toBeUndefined();
    const twins = [
      { id: "a", name: "Same", folder: null },
      { id: "b", name: "Same", folder: null },
    ];
    expect(resolveProject("Same", twins)).toBeUndefined();
    expect(sameProject("crew", "C:\\work\\crew", projects)).toBe(true);
    expect(sameProject("Crew", "crew", projects)).toBe(true);
    expect(sameProject("site", "C:\\work\\crew", projects)).toBe(false);
    expect(sameProject("../daily", "crew", projects)).toBe(false);
    expect(sameProject("", "crew", projects)).toBe(false);
    expect(sameProject("crew", "crew", [])).toBe(true);
  });
});

describe("readKeys and pageReadable", () => {
  const projects = copyProjects(known);
  const crew = projects[0];
  it("reads the id and the folder, and hides a page filed somewhere else", () => {
    expect(readKeys(crew)).toEqual(["crew", "C:\\work\\crew"]);
    expect(pageReadable("/work/site", undefined, projects)).toBe(true);
    expect(pageReadable("C:\\work\\crew", undefined, projects)).toBe(true);
    expect(pageReadable("/daily/app", undefined, projects)).toBe(false);
    expect(pageReadable(null, undefined, projects)).toBe(true);
    expect(pageReadable("/work/site", crew, projects)).toBe(false);
    expect(pageReadable("C:/work/crew", crew, projects)).toBe(true);
  });
});
