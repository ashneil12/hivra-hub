import { expect, it } from "vitest";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import { taskTextFor } from "./agentTasks";

const source = { id: "mono" };
const PROJECT = "/work/hivra";

function hostFor(record: unknown, over: Partial<AgentAppHost> = {}): Pick<AgentAppHost, "codingTeamOf" | "monoOf" | "taskStore"> {
  return {
    monoOf: () => ({ id: "mono", projects: [PROJECT] }),
    taskStore: async (_command, args) => ({ ...(record as Record<string, unknown>), id: args.id }),
    ...over,
  } as Pick<AgentAppHost, "codingTeamOf" | "monoOf" | "taskStore">;
}

it("reads the task's own words, trimmed and with plain line endings", async () => {
  const found = await taskTextFor(source, "task-1", hostFor({ title: "  Fix the save \r\n", description: " Last line\r\n  " }));
  expect(found).toEqual({ title: "Fix the save", description: "Last line" });
  const titleOnly = await taskTextFor(source, "task-1", hostFor({ title: "Fix the save", description: "  " }));
  expect(titleOnly).toEqual({ title: "Fix the save", description: "" });
});

it("reads a task a many-project chat can see, by the same keys tasks.get tries", async () => {
  const calls: string[] = [];
  const host = {
    monoOf: () => ({ id: "mono", projects: ["/work/a", "/work/b"] }),
    knownProjects: () => [
      { id: "a", name: "A", folder: "/work/a" },
      { id: "b", name: "B", folder: "/work/b" },
    ],
    taskStore: async (_command: string, args: { actor: { project: string } }) => {
      calls.push(args.actor.project);
      if (args.actor.project === "b") return { title: "Fix b", description: "Only in b." };
      throw new Error("No task with that id.");
    },
  } as unknown as Pick<AgentAppHost, "codingTeamOf" | "monoOf" | "knownProjects" | "taskStore">;
  expect(await taskTextFor(source, "task-1", host)).toEqual({ title: "Fix b", description: "Only in b." });
  expect(calls).toEqual(["a", "/work/a", "b"]);
});

it("treats a missing store, no project, a broken record and a slow store as no task text", async () => {
  expect(await taskTextFor(source, "task-1", hostFor({ title: "T", description: "D" }, { taskStore: undefined }))).toBeUndefined();
  expect(await taskTextFor(source, "task-1", hostFor({ title: "T", description: "D" }, { monoOf: () => undefined }))).toBeUndefined();
  expect(await taskTextFor(source, "task-1", hostFor({ title: 7, description: ["no"] }))).toBeUndefined();
  expect(await taskTextFor(source, "task-1", hostFor({ title: " ", description: "" }))).toBeUndefined();
  expect(await taskTextFor(source, "  ", hostFor({ title: "T", description: "D" }))).toBeUndefined();
  const slow = hostFor({});
  slow.taskStore = () => new Promise(() => {});
  expect(await taskTextFor(source, "task-1", slow, 5)).toBeUndefined();
  const failing = hostFor({});
  failing.taskStore = async () => {
    throw new Error("The store is unreachable.");
  };
  expect(await taskTextFor(source, "task-1", failing)).toBeUndefined();
});
