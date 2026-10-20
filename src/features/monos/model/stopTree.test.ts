// One Stop for a whole delegation tree (H4): everything beneath the stopped chat, depth first after the parent, only
// rows owned by a chat the Stop reached (following parent_id), owed reports thrown away, and a child that won't stop
// reported. After T3's ThreadManagementService.stopDelegatedTasks (MIT, pingdotgg/t3code @2532e640).
import { beforeEach, describe, expect, it } from "vitest";
import { DelegationTracker, type Delegation } from "./delegations";
import { MemoryDelegations } from "./memoryDelegations";
import {
  hasWorkBeneath,
  stopTask,
  stopTree,
  type StopTreeHost,
} from "./stopTree";

/**
 * Chief of Staff delegated a job to the EXO lead (double delegation); the lead, working for it, delegated two workers,
 * and the first worker a helper of its own. The lead also has one older task of its own, from before (not that job's).
 */
async function tree() {
  const store = new MemoryDelegations();
  const record = async (owner: string, child: string) =>
    store.record({
      ownerSession: owner,
      requestId: `${owner}>${child}`,
      childSession: child,
      title: child,
    });
  const older = await record("lead", "w9");
  const job = await record("cos", "lead");
  const w1 = await record("lead", "w1");
  const helper = await record("w1", "h1");
  const w2 = await record("lead", "w2");
  return { store, older, job, w1, helper, w2 };
}

function host(
  store: MemoryDelegations,
  busy: string[],
  options: { fail?: string[]; hang?: string[] } = {},
) {
  const events: string[] = [];
  const running = new Set(busy);
  const tracker = new DelegationTracker(store, {
    session: () => undefined,
    load: async () => null,
    openOwner: async () => null,
    isMono: () => true,
    queueReport: async () => {},
    quitting: () => false,
  });
  const api: StopTreeHost = {
    listOpen: () => store.listOpen(),
    tree: (id) => store.tree(id),
    cancel: async (owner, rows, reason, by) => {
      events.push(...rows.map((row) => `cancel:${row.childSession}`));
      return tracker.cancelOwned(owner, rows, reason, by);
    },
    busy: (id) => running.has(id),
    stop: async (id) => {
      events.push(`stop:${id}`);
      if (options.hang?.includes(id)) return new Promise<void>(() => {});
      if (options.fail?.includes(id)) throw new Error("would not stop");
      running.delete(id);
    },
    dropReport: (owner, child) => events.push(`drop:${owner}/${child}`),
    stopTimeoutMs: 30,
  };
  return { api, events, running };
}

const stops = (events: string[]) =>
  events.filter((e) => e.startsWith("stop:")).map((e) => e.slice(5));

describe("a Lead briefed by the leadership team (a followed brief)", () => {
  it("Stop on Chief of Staff takes a queued brief out of the Lead's queue and never stops the Lead's own chat; its workers stop", async () => {
    const store = new MemoryDelegations();
    const brief = await store.record({ ownerSession: "cos", requestId: "app-cos-b1", childSession: "lead", follow: "lead" });
    const waiting = await store.record({ ownerSession: "cos", requestId: "app-cos-b2", childSession: "lead", follow: "lead" });
    const w1 = await store.record({ ownerSession: "lead", requestId: "w1", childSession: "w1", parentId: brief.id });
    expect(w1.parentId).toBe(brief.id);
    const { api, events } = host(store, ["cos", "lead", "w1"]);
    const unqueued: string[] = [];
    api.unqueue = (child, request) => void unqueued.push(`${child}/${request}`);
    const result = await stopTree("cos", api, { reason: "Stopped by Ash.", by: "user" });
    expect(stops(events)).toEqual(["cos", "w1"]);
    expect(unqueued).toEqual(["lead/app-cos-b1", "lead/app-cos-b2"]);
    // Depth first: the first brief, the worker beneath it, then the brief still waiting.
    expect(result.cancelled).toEqual([brief.id, w1.id, waiting.id]);
  });
});

describe("stopTree", () => {
  let t: Awaited<ReturnType<typeof tree>>;
  beforeEach(async () => {
    t = await tree();
  });

  it("stops a leadership Mono, then everything beneath it, depth first after each parent", async () => {
    const { api, events } = host(t.store, [
      "cos",
      "lead",
      "w1",
      "h1",
      "w2",
      "w9",
    ]);
    const result = await stopTree("cos", api, {
      reason: "Stopped by Ash.",
      by: "user",
    });
    expect(stops(events)).toEqual(["cos", "lead", "w1", "h1", "w2"]);
    // Each row is cancelled before its worker stops (it keeps this reason), its report dropped after.
    expect(events.slice(1, 4)).toEqual([
      "cancel:lead",
      "stop:lead",
      "drop:cos/lead",
    ]);
    expect(result).toEqual({
      stopped: ["cos", "lead", "w1", "h1", "w2"],
      cancelled: [t.job.id, t.w1.id, t.helper.id, t.w2.id],
      stopFailed: [],
    });
    for (const row of [t.job, t.w1, t.helper, t.w2])
      expect(t.store.get(row.id)).toMatchObject({
        state: "cancelled",
        delivery: "disposed",
        error: "Stopped by Ash.",
      });
    expect(t.store.get(t.w1.id).log.at(-1)).toMatchObject({
      event: "cancelled",
      by: "user",
    });
    // The lead's own older task is not that job's: untouched.
    expect(t.store.get(t.older.id)).toMatchObject({
      state: "running",
      delivery: "pending",
    });
    expect(stops(events)).not.toContain("w9");
  });

  it("on a Lead stops every task it owns but nothing above it", async () => {
    const { api, events } = host(t.store, [
      "cos",
      "lead",
      "w1",
      "h1",
      "w2",
      "w9",
    ]);
    const result = await stopTree("lead", api, {
      reason: "Stopped by Ash.",
      by: "user",
    });
    expect(stops(events)).toEqual(["lead", "w9", "w1", "h1", "w2"]);
    expect(result.cancelled).toEqual([
      t.older.id,
      t.w1.id,
      t.helper.id,
      t.w2.id,
    ]);
    // The job Chief of Staff owns is Chief of Staff's: the Stop never touches a row it doesn't own.
    expect(t.store.get(t.job.id).state).toBe("running");
    expect(stops(events)).not.toContain("cos");
  });

  it("throws away a finished task's owed report, leaves a delivered one, and stops no idle chat", async () => {
    await t.store.settle({
      id: t.w2.id,
      generation: 1,
      state: "completed",
      result: "done",
    });
    await t.store.settle({
      id: t.older.id,
      generation: 1,
      state: "completed",
      result: "done",
    });
    await t.store.setDelivery({ ids: [t.older.id], delivery: "delivered" });
    const { api, events } = host(t.store, ["lead", "w1"]);
    const result = await stopTree("lead", api, {
      reason: "Stopped by Ash.",
      by: "user",
    });
    expect(stops(events)).toEqual(["lead", "w1"]);
    expect(events).toContain("drop:lead/w2");
    expect(events).not.toContain("drop:lead/w9");
    expect(t.store.get(t.w2.id)).toMatchObject({
      state: "completed",
      delivery: "disposed",
      result: "done",
    });
    expect(t.store.get(t.older.id)).toMatchObject({
      state: "completed",
      delivery: "delivered",
    });
    expect(result.cancelled).toEqual([t.w1.id, t.helper.id, t.w2.id]);
  });

  it("reports a child that failed or timed out, and goes on with the rest", async () => {
    const { api, events } = host(t.store, ["lead", "w1", "h1", "w2"], {
      fail: ["w1"],
      hang: ["w2"],
    });
    const result = await stopTree("lead", api, {
      reason: "Stopped by Ash.",
      by: "user",
    });
    expect(stops(events)).toEqual(["lead", "w1", "h1", "w2"]);
    expect(result.stopFailed).toEqual(["w1", "w2"]);
    expect(result.stopped).toEqual(["lead", "h1"]);
    // Its row is cancelled all the same: no report follows for it.
    expect(t.store.get(t.w1.id).delivery).toBe("disposed");
  });
});

describe("a Stop whose rows can't be loaded", () => {
  it("stops the chat and says its workers may still be running, instead of reporting a clean Stop", async () => {
    const t = await tree();
    const { api, events } = host(t.store, ["lead", "w1", "w2"]);
    api.listOpen = async () => {
      throw new Error("database is locked");
    };
    const result = await stopTree("lead", api, {
      reason: "Stopped by Ash.",
      by: "user",
    });
    expect(stops(events)).toEqual(["lead"]);
    expect(result.unloaded).toEqual(["lead"]);
    expect(result.stopFailed).toEqual([]);
  });

  it("a tree that fails to load is reported too (a finished row linking the workers may be missing)", async () => {
    const t = await tree();
    const { api } = host(t.store, ["lead", "w1"]);
    api.tree = async () => {
      throw new Error("database is locked");
    };
    const result = await stopTree("lead", api, {
      reason: "Stopped by Ash.",
      by: "user",
    });
    expect(result.unloaded).toEqual(["lead"]);
  });

  it("a task's Stop names the task's chat when what is beneath it can't be loaded", async () => {
    const t = await tree();
    const { api } = host(t.store, ["w1", "h1"]);
    api.listOpen = async () => {
      throw new Error("database is locked");
    };
    const result = await stopTask(t.w1 as Delegation, api, {
      reason: "Not needed any more",
      by: "user",
    });
    expect(result.stopped).toEqual(["w1"]);
    expect(result.unloaded).toEqual(["w1"]);
  });

  it("a row that can't be cancelled is reported as not stopped (its report could restart the work)", async () => {
    const t = await tree();
    const { api } = host(t.store, ["lead", "w1"]);
    api.cancel = async () => {
      throw new Error("database is locked");
    };
    const result = await stopTree("lead", api, {
      reason: "Stopped by Ash.",
      by: "user",
    });
    expect(result.stopFailed).toContain("w1");
    expect(result.unloaded).toBeUndefined();
  });

  it("a clean Stop carries no unloaded note", async () => {
    const t = await tree();
    const { api } = host(t.store, ["lead"]);
    const result = await stopTree("lead", api, {
      reason: "Stopped by Ash.",
      by: "user",
    });
    expect(result.unloaded).toBeUndefined();
  });
});

describe("stopTask (task_cancel, a row's Stop)", () => {
  it("stops that task's worker and what it delegated, nothing else", async () => {
    const t = await tree();
    const { api, events } = host(t.store, ["cos", "lead", "w1", "h1", "w2"]);
    const result = await stopTask(t.w1 as Delegation, api, {
      reason: "Not needed any more",
      by: "owner:lead",
    });
    expect(stops(events)).toEqual(["w1", "h1"]);
    expect(result.cancelled).toEqual([t.w1.id, t.helper.id]);
    expect(t.store.get(t.w1.id)).toMatchObject({
      state: "cancelled",
      error: "Not needed any more",
    });
    expect(t.store.get(t.w1.id).log.at(-1)).toMatchObject({ by: "owner:lead" });
    expect(t.store.get(t.w2.id).state).toBe("running");
    expect(t.store.get(t.job.id).state).toBe("running");
  });
});

it("knows when a Stop would reach anything beneath a chat", async () => {
  const t = await tree();
  const rows = await t.store.listOpen();
  expect(hasWorkBeneath("lead", rows)).toBe(true);
  expect(hasWorkBeneath("w2", rows)).toBe(false);
});
