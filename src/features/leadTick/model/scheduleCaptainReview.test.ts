// Review of PR #244, round 3 (WP-215). Red on a33c10b0c.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { createLeadTickStore } from "./store";
import { LeadTickScheduler, type SchedulerDeps } from "./schedule";
import type { LeadTickInput, LeadTickPorts, LeadTickResult } from "./tick";

const NOON = new Date(2026, 10, 10, 12, 0, 0).getTime();

describe("the lead tick's note (review of PR #244, round 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the tick the hub id the decision store keys a project by, not only the folder", async () => {
    // tick.ts notes a merge under `input.projectId?.trim() || input.folder`. The scheduler builds the input with the
    // folder only, so every note lands under "/code/app" while the project's decisions are under "app".
    const store = createLeadTickStore(memoryDisk());
    const inputs: LeadTickInput[] = [];
    const deps: SchedulerDeps = {
      store,
      now: () => Date.now(),
      quiet: () => ({ enabled: false, start: "22:00", end: "08:00" }),
      allowed: () => true,
      resolve: async () => ({
        projectId: "app",
        lead: { monoId: "app-lead", name: "Lead", sessionId: "s-lead" },
        look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false },
      }),
      ports: () => ({}) as LeadTickPorts,
      run: async (input: LeadTickInput): Promise<LeadTickResult> => {
        inputs.push(input);
        return { line: "Nothing to do this tick.", attention: [], noted: [] };
      },
    };
    await store.writeSetting("/code/app", { enabled: true, shipOnGreen: true });
    const scheduler = new LeadTickScheduler(deps);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].projectId).toBe("app");
  });
});
