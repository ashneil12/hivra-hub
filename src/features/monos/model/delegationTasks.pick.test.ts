// WP-141: tasks.pick reaches the crew through the same host as delegate_task's route.
import { expect, it, vi } from "vitest";
import { delegationTasksHost } from "./delegationTasks";

it("passes the crew pick and the Lead roster through to tasks.pick", () => {
  const crewPick = vi.fn(async () => ({ ok: true, cli: "codex", monoId: null, model: null, effort: null, reason: "Your default is Codex." }));
  const pickMonos = vi.fn(() => [{ id: "web-lead", name: "Web lead", lead: "web" }]);
  const tasks = delegationTasksHost({
    backend: {} as never,
    tracker: () => ({}) as never,
    session: () => undefined,
    stop: async () => undefined,
    dropReport: () => undefined,
    crewPick,
    pickMonos,
  });
  expect(tasks.crewPick).toBe(crewPick);
  expect(tasks.pickMonos).toBe(pickMonos);
  const bare = delegationTasksHost({
    backend: {} as never,
    tracker: () => ({}) as never,
    session: () => undefined,
    stop: async () => undefined,
    dropReport: () => undefined,
  });
  expect(bare.crewPick).toBeUndefined();
});

// LOW 6: the depth check's { fanout: false } reaches the store through the host, not only the mock.
it("passes the fanout option through the depth check to the store", async () => {
  const checkDepth = vi.fn(async () => 1);
  const tasks = delegationTasksHost({
    backend: { checkDepth } as never,
    tracker: () => ({}) as never,
    session: () => undefined,
    stop: async () => undefined,
    dropReport: () => undefined,
  });
  await tasks.checkDepth?.("mono-lead", { fanout: false });
  expect(checkDepth).toHaveBeenLastCalledWith("mono-lead", { fanout: false });
});
