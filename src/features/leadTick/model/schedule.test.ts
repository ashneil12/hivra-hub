import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { QuietHours } from "../../notifications/model/quietHours";
import { createLeadTickStore, type LeadTickStore } from "./store";
import { LEAD_TICK_LOOK_MS, LeadTickScheduler, leadBlockedReason, missedTicksLine, type SchedulerDeps } from "./schedule";
import type { LeadTickInput, LeadTickPorts, LeadTickResult } from "./tick";

const MIN = 60_000;
// 12:00 local on a fixed day, so quiet hours are easy to place.
const NOON = new Date(2026, 10, 10, 12, 0, 0).getTime();

type Lead = { busy?: boolean; asking?: boolean; queued?: boolean; limited?: boolean; resumeStopped?: boolean };

function setup(options: { quiet?: QuietHours; lead?: Lead | null; policy?: boolean; store?: LeadTickStore } = {}) {
  const store = options.store ?? createLeadTickStore(memoryDisk());
  const runs: { folder: string; at: number; input: LeadTickInput }[] = [];
  let lead: Lead | null = options.lead === undefined ? {} : options.lead;
  const deps: SchedulerDeps = {
    store,
    now: () => Date.now(),
    quiet: () => options.quiet ?? { enabled: false, start: "22:00", end: "08:00" },
    allowed: () => options.policy ?? true,
    resolve: async () =>
      lead === null
        ? { skip: "This project has no Lead yet." }
        : { projectId: "app", lead: { monoId: "app-lead", name: "Lead", sessionId: "s-lead" }, look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false, ...lead } },
    ports: () => ({}) as LeadTickPorts,
    run: async (input: LeadTickInput): Promise<LeadTickResult> => {
      runs.push({ folder: input.folder, at: Date.now(), input });
      return { line: "Nothing to do this tick.", attention: [], noted: [] };
    },
  };
  return {
    store,
    runs,
    scheduler: new LeadTickScheduler(deps),
    setLead: (next: Lead | null) => {
      lead = next;
    },
  };
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("lead tick cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("with Lead tick off, nothing runs", async () => {
    const { scheduler, runs } = setup();
    scheduler.start();
    await advance(2 * 60 * MIN);
    scheduler.stop();
    expect(runs).toEqual([]);
  });

  it("runs at once when turned on, then every 15 minutes by default", async () => {
    const { scheduler, runs, store } = setup();
    await store.writeSetting("/code/app", { enabled: true });
    scheduler.start();
    await advance(0);
    expect(runs).toHaveLength(1);
    await advance(14 * MIN);
    expect(runs).toHaveLength(1);
    await advance(1 * MIN + LEAD_TICK_LOOK_MS);
    expect(runs).toHaveLength(2);
    await advance(30 * MIN);
    expect(runs).toHaveLength(4);
    scheduler.stop();
    await advance(60 * MIN);
    expect(runs).toHaveLength(4);
  });

  it("follows the interval the person set", async () => {
    const { scheduler, runs, store } = setup();
    await store.writeSetting("/code/app", { enabled: true, intervalMinutes: 5 });
    scheduler.start();
    await advance(30 * MIN);
    scheduler.stop();
    expect(runs.length).toBeGreaterThanOrEqual(6);
    expect(runs.length).toBeLessThanOrEqual(7);
  });

  it("passes the tick interval to the ports so the lead lease can follow it", async () => {
    const store = createLeadTickStore(memoryDisk());
    await store.writeSetting("/code/app", { enabled: true, intervalMinutes: 60 });
    let seen: unknown;
    const scheduler = new LeadTickScheduler({
      store,
      now: () => Date.now(),
      quiet: () => ({ enabled: false, start: "22:00", end: "08:00" }),
      allowed: () => true,
      resolve: async () => ({
        projectId: "app",
        lead: { monoId: "app-lead", name: "Lead", sessionId: "s-lead" },
        look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false },
      }),
      ports: (_folder, _context, intervalMinutes?: number) => {
        seen = intervalMinutes;
        return {} as LeadTickPorts;
      },
      run: async () => ({ line: "Nothing to do this tick.", attention: [], noted: [] }),
    });
    scheduler.start();
    await advance(0);
    scheduler.stop();
    expect(seen).toBe(60);
  });

  it("passes Ship on green through, off unless turned on", async () => {
    const { scheduler, runs, store } = setup();
    await store.writeSetting("/code/app", { enabled: true });
    scheduler.start();
    await advance(0);
    expect(runs[0].input.shipOnGreen).toBe(false);
    await store.writeSetting("/code/app", { shipOnGreen: true });
    await advance(16 * MIN);
    scheduler.stop();
    expect(runs.at(-1)!.input.shipOnGreen).toBe(true);
  });

  it("keeps the last tick across a restart, so a reopened app does not tick early", async () => {
    const disk = memoryDisk();
    const first = setup({ store: createLeadTickStore(disk) });
    await first.store.writeSetting("/code/app", { enabled: true });
    first.scheduler.start();
    await advance(0);
    first.scheduler.stop();
    expect(first.runs).toHaveLength(1);

    await advance(5 * MIN);
    const second = setup({ store: createLeadTickStore(disk) });
    second.scheduler.start();
    await advance(LEAD_TICK_LOOK_MS);
    expect(second.runs).toHaveLength(0);
    await advance(10 * MIN);
    second.scheduler.stop();
    expect(second.runs).toHaveLength(1);
  });

  it("keeps ticking through quiet hours, and marks what it tells the person as held", async () => {
    // Quiet from 11:00 to 13:00; it is noon.
    const { store } = setup();
    await store.writeSetting("/code/app", { enabled: true, intervalMinutes: 5 });
    const told: { lines: string[]; held: boolean }[] = [];
    const scheduler = new LeadTickScheduler({
      store,
      now: () => Date.now(),
      quiet: () => ({ enabled: true, start: "11:00", end: "13:00" }),
      allowed: () => true,
      resolve: async () => ({ projectId: "app", lead: { monoId: "m", name: "Lead", sessionId: "s" }, look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false } }),
      ports: () => ({}) as LeadTickPorts,
      run: async () => ({ line: "Started WP-1.", attention: ["#7 (WP-200) needs your word to merge."], noted: [] }),
      tell: (_folder, lines, _at, held) => told.push({ lines: [...lines], held }),
    });
    scheduler.start();
    await advance(0);
    scheduler.stop();
    expect(told).toEqual([{ lines: ["#7 (WP-200) needs your word to merge."], held: true }]);
    expect(store.runFor("/code/app")?.lastLine).toBe("Started WP-1.");
  });

  it("backs off when the run cannot be recorded, instead of ticking again the next minute", async () => {
    const { store } = setup();
    await store.writeSetting("/code/app", { enabled: true, intervalMinutes: 5 });
    let failures = 1;
    const record = store.recordRun;
    store.recordRun = async (folder, run) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("database is busy");
      }
      return record(folder, run);
    };
    const started: number[] = [];
    const scheduler = new LeadTickScheduler({
      store,
      now: () => Date.now(),
      quiet: () => ({ enabled: false, start: "22:00", end: "08:00" }),
      allowed: () => true,
      resolve: async () => ({ projectId: "app", lead: { monoId: "m", name: "Lead", sessionId: "s" }, look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false } }),
      ports: () => ({}) as LeadTickPorts,
      run: async () => {
        started.push(Date.now());
        return { line: "Nothing to do this tick.", attention: [], noted: [] };
      },
    });
    scheduler.start();
    await advance(4 * MIN);
    expect(started).toHaveLength(1);
    await advance(2 * MIN);
    scheduler.stop();
    expect(started).toHaveLength(2);
  });

  it("keeps every said-once key up to the store's limit", async () => {
    const { store } = setup();
    await store.writeSetting("/code/app", { enabled: true, intervalMinutes: 5 });
    const keys = Array.from({ length: 60 }, (_, index) => `key-${index}`);
    const scheduler = new LeadTickScheduler({
      store,
      now: () => Date.now(),
      quiet: () => ({ enabled: false, start: "22:00", end: "08:00" }),
      allowed: () => true,
      resolve: async () => ({ projectId: "app", lead: { monoId: "m", name: "Lead", sessionId: "s" }, look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false } }),
      ports: () => ({}) as LeadTickPorts,
      run: async () => ({ line: "Nothing to do this tick.", attention: [], noted: keys }),
    });
    scheduler.start();
    await advance(0);
    scheduler.stop();
    expect(store.runFor("/code/app")?.noted).toEqual(keys);
  });

  it("nothing ticks while the Lead is busy or blocked, and it ticks once the Lead is free", async () => {
    for (const blocked of [{ busy: true }, { asking: true }, { queued: true }, { limited: true }, { resumeStopped: true }]) {
      const { scheduler, runs, store, setLead } = setup({ lead: blocked });
      await store.writeSetting("/code/app", { enabled: true });
      scheduler.start();
      await advance(30 * MIN);
      expect(runs).toEqual([]);
      setLead({});
      await advance(LEAD_TICK_LOOK_MS);
      scheduler.stop();
      expect(runs).toHaveLength(1);
    }
  });

  it("does not tick with no Lead, and says why", async () => {
    const { scheduler, runs, store } = setup({ lead: null });
    await store.writeSetting("/code/app", { enabled: true });
    scheduler.start();
    await advance(LEAD_TICK_LOOK_MS);
    scheduler.stop();
    expect(runs).toEqual([]);
    expect(store.runFor("/code/app")?.lastLine).toBe("This project has no Lead yet.");
  });

  it("never ticks where the app's policy turns automations off (a dev copy)", async () => {
    const { scheduler, runs, store } = setup({ policy: false });
    await store.writeSetting("/code/app", { enabled: true });
    scheduler.start();
    await advance(60 * MIN);
    scheduler.stop();
    expect(runs).toEqual([]);
  });

  it("runs one tick per project at a time", async () => {
    const { store } = setup();
    await store.writeSetting("/code/app", { enabled: true, intervalMinutes: 5 });
    let release: () => void = () => undefined;
    let started = 0;
    const scheduler = new LeadTickScheduler({
      store,
      now: () => Date.now(),
      quiet: () => ({ enabled: false, start: "22:00", end: "08:00" }),
      allowed: () => true,
      resolve: async () => ({ projectId: "app", lead: { monoId: "m", name: "Lead", sessionId: "s" }, look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false } }),
      ports: () => ({}) as LeadTickPorts,
      run: () => {
        started += 1;
        return new Promise((resolve) => {
          release = () => resolve({ line: "done", attention: [], noted: [] });
        });
      },
    });
    scheduler.start();
    await advance(20 * MIN);
    expect(started).toBe(1);
    release();
    await advance(LEAD_TICK_LOOK_MS);
    scheduler.stop();
    expect(started).toBe(2);
  });

  it("tells the person only what needs them, never routine progress", async () => {
    const { store } = setup();
    await store.writeSetting("/code/app", { enabled: true, intervalMinutes: 5 });
    const told: string[][] = [];
    let attention = ["#7 (WP-200) needs your word to merge."];
    const scheduler = new LeadTickScheduler({
      store,
      now: () => Date.now(),
      quiet: () => ({ enabled: false, start: "22:00", end: "08:00" }),
      allowed: () => true,
      resolve: async () => ({ projectId: "app", lead: { monoId: "m", name: "Lead", sessionId: "s" }, look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false } }),
      ports: () => ({}) as LeadTickPorts,
      run: async () => ({ line: "Started WP-1.", attention, noted: [] }),
      tell: (_folder, lines) => told.push([...lines]),
    });
    scheduler.start();
    await advance(0);
    attention = [];
    await advance(6 * MIN);
    scheduler.stop();
    expect(told).toEqual([["#7 (WP-200) needs your word to merge."]]);
  });

  it("records the tick's line and what it said", async () => {
    const { store } = setup();
    await store.writeSetting("/code/app", { enabled: true });
    const scheduler = new LeadTickScheduler({
      store,
      now: () => Date.now(),
      quiet: () => ({ enabled: false, start: "22:00", end: "08:00" }),
      allowed: () => true,
      resolve: async () => ({ projectId: "app", lead: { monoId: "m", name: "Lead", sessionId: "s" }, look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false } }),
      ports: () => ({}) as LeadTickPorts,
      run: async (input) => ({ line: "Started WP-1.", attention: [], noted: [...input.noted, "k1"] }),
    });
    scheduler.start();
    await advance(0);
    scheduler.stop();
    expect(store.runFor("/code/app")).toEqual({ lastTickAt: NOON, lastLine: "Started WP-1.", noted: ["k1"] });
  });
});

describe("lead blocked reason", () => {
  it("names what holds the Lead", () => {
    expect(leadBlockedReason({ busy: false, asking: false, queued: false, limited: false, resumeStopped: false })).toBeNull();
    expect(leadBlockedReason({ busy: true, asking: false, queued: false, limited: false, resumeStopped: false })).toBe("The Lead is working.");
    expect(leadBlockedReason({ busy: false, asking: true, queued: false, limited: false, resumeStopped: false })).toBe("The Lead is waiting on an answer.");
  });
});

describe("missed ticks copy", () => {
  it("says plainly that a closed app misses ticks", () => {
    const setting = { enabled: true, intervalMinutes: 15, shipOnGreen: false };
    expect(missedTicksLine(setting, { lastTickAt: NOON, lastLine: "", noted: [] }, NOON + 20 * MIN)).toBeNull();
    const line = missedTicksLine(setting, { lastTickAt: NOON, lastLine: "", noted: [] }, NOON + 3 * 60 * MIN);
    expect(line).toMatch(/^No tick ran for 3 hours\. /);
    expect(line).toContain("only while Hivra is open");
    expect(line).not.toMatch(/[–—]/);
    expect(missedTicksLine({ ...setting, enabled: false }, { lastTickAt: NOON, lastLine: "", noted: [] }, NOON + 5 * 60 * MIN)).toBeNull();
    expect(missedTicksLine(setting, undefined, NOON)).toBeNull();
  });
});
