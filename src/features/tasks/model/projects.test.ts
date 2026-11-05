import { describe, expect, it } from "vitest";
import { statusProjectIds, taskProjectKeys } from "./projects";

describe("taskProjectKeys", () => {
  const projects = [
    { id: "hivra", folder: "/work/Hivra App" },
    { id: "other", folder: "C:\\Code\\Other" },
    { id: "blank", folder: null },
    { id: "empty", folder: "" },
  ];

  it("writes under the hub project and still reads the folder", () => {
    expect(taskProjectKeys("/work/Hivra App/", projects)).toEqual({
      write: "hivra",
      read: ["hivra", "/work/Hivra App/"],
    });
  });

  it("matches a Windows path without resolving it", () => {
    expect(taskProjectKeys("C:\\Code\\Other", projects).write).toBe("other");
    expect(taskProjectKeys("/work/../secret", projects)).toEqual({
      write: "/work/../secret",
      read: ["/work/../secret"],
    });
  });

  it("keeps a folder with spaces or a mark that matches nothing", () => {
    expect(taskProjectKeys("/work/Ünicode App", projects).write).toBe("/work/Ünicode App");
    expect(taskProjectKeys("", projects)).toEqual({ write: "", read: [] });
  });

  it("uses the first project when two share a folder", () => {
    const doubled = [...projects, { id: "again", folder: "/work/Hivra App" }];
    expect(taskProjectKeys("/work/Hivra App", doubled).write).toBe("hivra");
  });
});

describe("statusProjectIds", () => {
  const projects = [
    { id: "hivra", folder: "/work/Hivra App" },
    { id: "other", folder: "C:\\Code\\Other" },
    { id: "blank", folder: null },
    { id: "empty", folder: "" },
    { id: "", folder: "/skip" },
    { id: "café team", folder: "/work/Ünicode App" },
  ];

  it("asks a project page for that project's id, not its folder", () => {
    expect(statusProjectIds("project", "/work/Hivra App/", projects)).toEqual(["hivra"]);
    expect(statusProjectIds("project", "C:\\Code\\Other", projects)).toEqual(["other"]);
    expect(statusProjectIds("project", "/work/Ünicode App", projects)).toEqual(["café team"]);
    expect(statusProjectIds("project", "/work/../secret", projects)).toEqual(["/work/../secret"]);
    expect(statusProjectIds("project", "", projects)).toEqual([]);
  });

  it("asks All tasks once per project id and not for a folder path", () => {
    expect(statusProjectIds("all", "/work/Hivra App", projects)).toEqual(["hivra", "other", "blank", "empty", "café team"]);
    expect(statusProjectIds("all", "/somewhere/else", [...projects, { id: "hivra", folder: "/dup" }])).toEqual([
      "hivra",
      "other",
      "blank",
      "empty",
      "café team",
      "/somewhere/else",
    ]);
  });
});
