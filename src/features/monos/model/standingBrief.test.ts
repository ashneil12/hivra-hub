// @vitest-environment happy-dom
// WP-156: a standing-answers lookup that fails is not a failed brief.
import { describe, expect, it, vi } from "vitest";
import type { FirstMateBackend } from "../../firstmate/model/steering";
import { delegationTasksHost } from "./delegationTasks";
import type { DelegationsBackend } from "./delegations";

describe("standing answers on a Lead brief", () => {
  function host(standingBrief: FirstMateBackend["standingBrief"]) {
    return delegationTasksHost({
      backend: {} as DelegationsBackend,
      tracker: () => null,
      session: () => undefined,
      stop: async () => undefined,
      dropReport: () => undefined,
      firstMate: { backend: { standingBrief } as FirstMateBackend },
    });
  }

  it("returns the block, and an empty string when the lookup fails or is absent", async () => {
    const block = "Standing answers\nS-1: Keep them? -> Keep";
    const tasks = host(async () => block);
    expect(await tasks.standingBrief!("hivra")).toBe(block);

    const down = host(async () => {
      throw new Error("timed out");
    });
    expect(await down.standingBrief!("hivra")).toBe("");

    const off = delegationTasksHost({
      backend: {} as DelegationsBackend,
      tracker: () => null,
      session: () => undefined,
      stop: async () => undefined,
      dropReport: () => undefined,
      firstMate: { backend: {} as FirstMateBackend },
    });
    expect(off.standingBrief).toBeUndefined();
  });

  it("uses the named Lead's project, and leaves it out when the app has none", async () => {
    const leadProject = vi.fn(async () => "billing-app");
    const tasks = delegationTasksHost({
      backend: {} as DelegationsBackend,
      tracker: () => null,
      session: () => undefined,
      stop: async () => undefined,
      dropReport: () => undefined,
      leadProject,
    });
    expect(await tasks.leadProject?.({} as never, { id: "ada" }, "hub")).toBe("billing-app");
    expect(host(async () => "").leadProject).toBeUndefined();
  });
});
