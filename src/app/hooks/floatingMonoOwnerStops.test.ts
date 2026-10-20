import { afterEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ stopHarnessTask: vi.fn() }));
vi.mock("../../integrations/harness/core/registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stopHarnessTask: harness.stopHarnessTask,
}));

import {
  resetDelegationStore,
  setDelegationActions,
  setDelegationRows,
  stopFailures,
  type DelegationActions,
} from "../../features/monos/model/delegationStore";
import type { Delegation } from "../../features/monos/model/delegations";
import { floatingMonoOwnerStops } from "./useFloatingMono";

afterEach(() => {
  resetDelegationStore();
  harness.stopHarnessTask.mockReset();
});

const row = (childSession: string, ownerSession: string, state: Delegation["state"]) =>
  ({ id: `d-${childSession}`, childSession, ownerSession, state }) as Delegation;

function actions(): DelegationActions & { stopTree: ReturnType<typeof vi.fn>; stopRow: ReturnType<typeof vi.fn> } {
  const lent = {
    openOwner: vi.fn(),
    openChild: vi.fn(),
    stopTree: vi.fn().mockResolvedValue({ stopped: [], cancelled: [], stopFailed: [] }),
    stopRow: vi.fn().mockResolvedValue({ stopped: [], cancelled: [], stopFailed: ["worker-a"] }),
  };
  setDelegationActions(lent);
  return lent;
}

it("stops a workflow run the way the main chat's run row does", async () => {
  harness.stopHarnessTask.mockResolvedValue(true);
  await floatingMonoOwnerStops.stopWorkflow("lead", "claude", "wtask");
  expect(harness.stopHarnessTask).toHaveBeenCalledWith("claude", "lead", "wtask");
});

it("stops everything a chat delegated with the tree's own Stop all", async () => {
  const lent = actions();
  await floatingMonoOwnerStops.stopTree("lead");
  expect(lent.stopTree).toHaveBeenCalledWith("lead");
});

it("stops one running task only for the chat that handed it out, and keeps what it couldn't stop", async () => {
  const lent = actions();
  setDelegationRows([
    row("worker-a", "lead", "running"),
    row("worker-b", "someone-else", "running"),
    row("worker-c", "lead", "completed"),
  ]);
  await floatingMonoOwnerStops.stopRow("lead", "worker-a");
  expect(lent.stopRow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ childSession: "worker-a" }));
  expect(stopFailures("lead")).toEqual(["worker-a"]);
  await expect(floatingMonoOwnerStops.stopRow("lead", "worker-b")).rejects.toThrow("isn't running");
  await expect(floatingMonoOwnerStops.stopRow("lead", "worker-c")).rejects.toThrow("isn't running");
  expect(lent.stopRow).toHaveBeenCalledTimes(1);
});
