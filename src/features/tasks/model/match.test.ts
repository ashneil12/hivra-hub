import { expect, test } from "vitest";
import { emptyFilter, type FilterGroup } from "../vendor/views/viewState";
import { taskMatches, type MatchTask } from "./match";

const task: MatchTask = {
  title: "Fix the save",
  description: "Last line",
  status: "In progress",
  category: "started",
  priority: "high",
  assignee: "ada",
  projectId: "crew",
  labels: ["Bug"],
  parentId: null,
  dueAt: Date.parse("2026-10-01T12:00:00Z"),
  createdAt: Date.parse("2026-09-01T00:00:00Z"),
  updatedAt: Date.parse("2026-09-02T00:00:00Z"),
  subIssueCount: 0,
  creatorId: "person",
};

test("an empty filter shows every task, including one with nothing filled in", () => {
  expect(taskMatches(task, emptyFilter())).toBe(true);
  expect(taskMatches(task, null)).toBe(true);
  expect(taskMatches({}, emptyFilter())).toBe(true);
  expect(taskMatches(task, { op: "and", children: [] })).toBe(true);
});

test("title text and status narrow the list, and a duplicate condition still matches", () => {
  const text: FilterGroup = { op: "and", children: [{ field: "text", operator: "contains", value: "SAVE" }] };
  expect(taskMatches(task, text)).toBe(true);
  expect(taskMatches(task, { op: "and", children: [{ field: "text", operator: "contains", value: "missing" }] })).toBe(false);
  const status: FilterGroup = {
    op: "and",
    children: [
      { field: "status", operator: "is", value: ["In progress"] },
      { field: "status", operator: "is", value: ["In progress"] },
    ],
  };
  expect(taskMatches(task, status)).toBe(true);
  expect(taskMatches(task, { op: "and", children: [{ field: "status", operator: "is_not", value: ["In progress"] }] })).toBe(false);
});

test("a condition this build does not understand is skipped", () => {
  const broken = {
    op: "and",
    children: [
      { field: "not-a-field", operator: "is", value: ["x"] },
      { field: "status", operator: "is", value: ["In progress"] },
      { op: "nope", children: "bad" },
    ],
  } as unknown as FilterGroup;
  expect(taskMatches(task, broken)).toBe(true);
  const onlyBad = { op: "or", children: [{ field: "nope" as "text", operator: "contains", value: 3 }] } as unknown as FilterGroup;
  expect(() => taskMatches(task, onlyBad)).not.toThrow();
  expect(taskMatches(task, onlyBad)).toBe(true);
});

test("me, labels, due dates and a missing value do not throw", () => {
  expect(taskMatches(task, { op: "and", children: [{ field: "assignee", operator: "is", value: ["me"] }] }, { currentUserId: "ada" })).toBe(true);
  expect(taskMatches(task, { op: "and", children: [{ field: "assignee", operator: "is", value: ["me"] }] })).toBe(false);
  expect(taskMatches(task, { op: "and", children: [{ field: "label", operator: "includes_any", value: ["Bug", "UI"] }] })).toBe(true);
  expect(taskMatches({ title: "Bare" }, { op: "and", children: [{ field: "label", operator: "includes_all", value: ["Bug"] }] })).toBe(false);
  const before = Date.parse("2026-10-02T00:00:00Z");
  expect(
    taskMatches(task, { op: "and", children: [{ field: "due_date", operator: "before", value: { absolute: "2026-10-02" } }] }, { now: new Date(before) }),
  ).toBe(true);
  expect(taskMatches({ title: "No due" }, { op: "and", children: [{ field: "due_date", operator: "before", value: { absolute: "2026-10-02" } }] })).toBe(false);
  expect(taskMatches(task, { op: "and", children: [{ field: "due_date", operator: "before", value: { absolute: "not-a-date" } }] })).toBe(true);
});
