import { expect, test } from "vitest";
import { fallbackStatuses, hivraFields, readStoreTasks, toOrbitTasks } from "./mapTask";

const person = {
  id: "task-1",
  projectId: "crew",
  number: 1,
  title: "Write the notes",
  description: "Plain",
  status: "Todo",
  priority: "high",
  labels: ["Notes"],
  parentId: null,
  assignee: "ada",
  dueAt: Date.parse("2026-10-01T12:00:00Z"),
  sortKey: "b",
  version: 2,
  createdAt: Date.parse("2026-09-01T00:00:00Z"),
  updatedAt: Date.parse("2026-09-02T00:00:00Z"),
};

test("a person task keeps its due date and drops an agent span", () => {
  const [task] = toOrbitTasks(readStoreTasks([person]), fallbackStatuses("crew"), Date.parse("2026-10-02T00:00:00Z"));
  expect(task?.statusId).toBe("Todo");
  expect(task?.dueStartAt).toBeNull();
  expect(task?.dueAt).toBe("2026-10-01T12:00:00.000Z");
  expect(task?.assigneeIds).toEqual(["ada"]);
  expect(task?.priority).toBe("high");
  expect(task?.labels).toEqual(["Notes"]);
});

test("an agent bar runs from when the work started to when it finished", () => {
  const now = Date.parse("2026-03-10T00:00:00Z");
  const tasks = readStoreTasks([
    {
      ...person,
      id: "parent",
      sortKey: "a",
      delegationId: "del-1",
      cli: "claude",
      createdAt: Date.parse("2026-03-01T00:00:00Z"),
      workingSince: Date.parse("2026-03-02T00:00:00Z"),
      finishedAt: null,
      dueAt: null,
    },
    { ...person, id: "child", parentId: "parent", status: "Done", number: 2, sortKey: "c" },
    { id: "nope" },
    person,
  ]);
  expect(tasks.map((task) => task.id)).toEqual(["parent", "child", "task-1"]);
  const orbit = toOrbitTasks(tasks, fallbackStatuses("crew"), now);
  const agent = orbit.find((task) => task.id === "parent");
  expect(agent?.dueStartAt).toBe("2026-03-01T00:00:00.000Z");
  expect(agent?.dueAt).toBe("2026-03-10T00:00:00.000Z");
  expect(agent?.subIssueCount).toBe(1);
  expect(agent?.subIssueClosedCount).toBe(1);
  const finished = toOrbitTasks(
    readStoreTasks([{ ...person, id: "done", delegationId: "del-2", createdAt: Date.parse("2026-03-01T00:00:00Z"), finishedAt: Date.parse("2026-03-04T00:00:00Z"), workingSince: null }]),
    fallbackStatuses("crew"),
    now,
  )[0];
  expect(finished?.dueAt).toBe("2026-03-04T00:00:00.000Z");
});

test("a bad priority, a duplicate id and a missing list do not throw", () => {
  expect(readStoreTasks(null)).toEqual([]);
  expect(readStoreTasks([{ id: "a", title: "A", priority: "nope" }, { id: "a", title: "again" }])).toHaveLength(1);
  const [task] = toOrbitTasks(readStoreTasks([{ id: "a", title: "A", priority: "nope", projectId: "crew" }]), [], 0);
  expect(task?.priority).toBe("none");
  expect(task?.statusId).toBe("Backlog");
});

test("a drop writes one status name and one assignee", () => {
  expect(hivraFields({ status_id: "Done", assignee_ids: ["ada", "bea"], label_ids: ["Bug"] })).toEqual({
    status: "Done",
    assignee: "ada",
    labels: ["Bug"],
  });
  expect(hivraFields({ assignee_ids: [] })).toEqual({ assignee: null });
  expect(hivraFields({ priority: "low" })).toEqual({ priority: "low" });
});
