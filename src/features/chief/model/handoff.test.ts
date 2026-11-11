import { describe, expect, it, vi } from "vitest";
import { captainCanRead, captainHandoff, delegationId, filedTaskId } from "./handoff";
import { EVERY_PROJECT_LINE } from "./scope";

const chief = { everyProject: true, instructions: `Role\n${EVERY_PROJECT_LINE}\n`, projects: [] as string[] };

describe("captain.handoff", () => {
  it("files the task before it delegates, and answers with both ids", async () => {
    const order: string[] = [];
    const result = await captainHandoff(
      { project: "hivra", title: "Example: tighten the gate", brief: "Example: keep the red lines." },
      {
        canRead: () => true,
        createTask: async () => {
          order.push("create");
          return { id: "task-1" };
        },
        delegate: async (task) => {
          order.push(`delegate ${task.taskId}`);
          return { id: "del-9" };
        },
      },
    );
    expect(order).toEqual(["create", "delegate task-1"]);
    expect(result).toMatchObject({
      taskId: "task-1",
      delegationId: "del-9",
      department: "Coding",
      line: "Handed to Coding: Example: tighten the gate",
    });
  });

  it("refuses a project the chief cannot read, and files nothing", async () => {
    const createTask = vi.fn();
    await expect(
      captainHandoff(
        { project: "exo", title: "Example: a title", brief: "Example: a brief" },
        { canRead: () => false, createTask, delegate: vi.fn() },
      ),
    ).rejects.toThrow(/cannot read/);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("reads every project only when the scope says so, and names Coding when no department is given", () => {
    expect(captainCanRead(chief, "exo")).toBe(true);
    expect(captainCanRead({ everyProject: true, instructions: "no line", projects: [] }, "exo")).toBe(false);
    expect(captainCanRead({ projects: ["hivra"] }, "hivra")).toBe(true);
    expect(captainCanRead({ projects: ["hivra"] }, "exo")).toBe(false);
    expect(captainCanRead(undefined, "hivra")).toBe(false);
  });

  it("reads the filed id from the task, and the delegation id from the row", () => {
    expect(filedTaskId({ stale: false, task: { id: "task-2" }, changed: [] })).toBe("task-2");
    expect(delegationId({ taskId: "del-2", childSessionId: "app-x" })).toBe("del-2");
    expect(delegationId({ childSessionId: "app-x" })).toBe("app-x");
    expect(() => filedTaskId({ id: "nope" })).toThrow(/not filed/);
  });

  it("refuses an empty title", async () => {
    await expect(
      captainHandoff({ project: "hivra", title: "  ", brief: "Example: brief" }, { canRead: () => true, createTask: vi.fn(), delegate: vi.fn() }),
    ).rejects.toThrow(/title/i);
  });
});
