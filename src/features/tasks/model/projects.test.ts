import { describe, expect, it } from "vitest";
import { taskProjectKeys } from "./projects";

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
