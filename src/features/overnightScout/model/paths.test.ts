import { describe, expect, it } from "vitest";
import { fileInside, projectKeyFromCwd, SOURCES_FILE } from "./paths";

describe("scout paths", () => {
  it("stays inside an absolute folder, including spaces and a windows drive", () => {
    expect(fileInside("/work/my crew", SOURCES_FILE)).toBe("/work/my crew/docs/hivra/SOURCES.md");
    expect(fileInside("/work/クルー", "watch.md")).toBe("/work/クルー/watch.md");
    expect(fileInside("C:/work/my crew", SOURCES_FILE)).toBe("C:/work/my crew/docs/hivra/SOURCES.md");
    expect(fileInside("C:\\work\\my crew", "watch.md")).toBe("C:/work/my crew/watch.md");
  });

  it("refuses a path that climbs out, a relative root, or a blank", () => {
    expect(fileInside("/work/crew", "../../etc/passwd")).toBeNull();
    expect(fileInside("/work/crew/../outside", SOURCES_FILE)).toBeNull();
    expect(fileInside("C:\\work\\..\\outside", "watch.md")).toBeNull();
    expect(fileInside("/work/crew", "docs\\..\\secret")).toBeNull();
    expect(fileInside("/work/crew", "docs/\u0000/secret")).toBeNull();
    expect(fileInside("work/crew", SOURCES_FILE)).toBeNull();
    expect(fileInside("..", SOURCES_FILE)).toBeNull();
    expect(fileInside("", "watch.md")).toBeNull();
    expect(fileInside("/work/crew", "")).toBeNull();
    expect(fileInside("/work/crew\0", "watch.md")).toBeNull();
  });

  it("keeps a project id from the folder name and drops the rest of the path", () => {
    expect(projectKeyFromCwd("/work/my crew")).toBe("my-crew");
    expect(projectKeyFromCwd("C:\\work\\My Crew")).toBe("my-crew");
    expect(projectKeyFromCwd("/")).toBe("project");
    expect(projectKeyFromCwd("")).toBe("project");
    expect(projectKeyFromCwd("..")).toBe("project");
    expect(projectKeyFromCwd("/work/クルー")).toBe("project");
  });
});
