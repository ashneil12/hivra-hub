import { expect, it } from "vitest";
import { documentPath, persistDocs } from "./files";

it("keeps a document inside the task folder", () => {
  expect(documentPath("/tmp/phase root", "tâche", "01-research.md")).toBe("/tmp/phase root/tâche/01-research.md");
  expect(documentPath("C:/tasks", "task 1", "02-design.md")).toBe("C:/tasks/task 1/02-design.md");
});

it("refuses a path that could leave the folder", () => {
  expect(documentPath("/tmp/tasks", "..", "01-research.md")).toBeUndefined();
  expect(documentPath("/tmp/tasks", "task", "../01-research.md")).toBeUndefined();
  expect(documentPath("/tmp/tasks", "task", "")).toBeUndefined();
  expect(documentPath("/tmp/tasks", "a/b", "01-research.md")).toBeUndefined();
  expect(documentPath("/tmp/tasks", "task", "..\\..\\Windows\\system.ini")).toBeUndefined();
  expect(documentPath("", "task", "01-research.md")).toBeUndefined();
  expect(documentPath("/tmp/tasks", "task", "/etc/passwd")).toBeUndefined();
});

it("writes one file per number and skips a bad name", () => {
  const writes: [string, string][] = [];
  const written = persistDocs(
    "/tmp/phase root",
    "task",
    [
      { number: 1, fileName: "01-research.md", body: "a\r\nb" },
      { number: 1, fileName: "01-research.md", body: "dup" },
      { number: 2, fileName: "../x.md", body: "no" },
    ],
    (path, body) => writes.push([path, body]),
  );
  expect(written).toEqual(["/tmp/phase root/task/01-research.md"]);
  expect(writes).toEqual([["/tmp/phase root/task/01-research.md", "a\r\nb"]]);
});
