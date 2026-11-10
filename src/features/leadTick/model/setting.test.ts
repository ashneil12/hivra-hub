import { describe, expect, it } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import {
  DEFAULT_INTERVAL_MINUTES,
  LEAD_TICK_DOC_KEY,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  readLeadTickSetting,
} from "./setting";
import { createLeadTickStore, NOTED_LIMIT } from "./store";

describe("lead tick setting", () => {
  it("is off by default, every 15 minutes, with Ship on green off", () => {
    expect(readLeadTickSetting(undefined)).toEqual({ enabled: false, intervalMinutes: 15, shipOnGreen: false });
    expect(DEFAULT_INTERVAL_MINUTES).toBe(15);
  });

  it("turns on only for a real true", () => {
    expect(readLeadTickSetting({ enabled: "true", shipOnGreen: 1 })).toMatchObject({ enabled: false, shipOnGreen: false });
    expect(readLeadTickSetting({ enabled: true, shipOnGreen: true })).toMatchObject({ enabled: true, shipOnGreen: true });
  });

  it("keeps the interval at 5 minutes or more and falls back on a bad value", () => {
    expect(readLeadTickSetting({ intervalMinutes: 2 }).intervalMinutes).toBe(MIN_INTERVAL_MINUTES);
    expect(MIN_INTERVAL_MINUTES).toBe(5);
    expect(readLeadTickSetting({ intervalMinutes: 5 }).intervalMinutes).toBe(5);
    expect(readLeadTickSetting({ intervalMinutes: 30.4 }).intervalMinutes).toBe(30);
    expect(readLeadTickSetting({ intervalMinutes: 100_000 }).intervalMinutes).toBe(MAX_INTERVAL_MINUTES);
    expect(readLeadTickSetting({ intervalMinutes: "20" }).intervalMinutes).toBe(15);
    expect(readLeadTickSetting({ intervalMinutes: Number.NaN }).intervalMinutes).toBe(15);
    expect(readLeadTickSetting([]).intervalMinutes).toBe(15);
  });
});

describe("lead tick store", () => {
  it("keeps each project's setting in the app's database and reads it back after a restart", async () => {
    const disk = memoryDisk();
    const store = createLeadTickStore(disk);
    await store.writeSetting("/code/app/", { enabled: true, intervalMinutes: 3 });
    expect(store.settingFor("/code/app")).toEqual({ enabled: true, intervalMinutes: 5, shipOnGreen: false });

    const again = createLeadTickStore(disk);
    await again.load();
    expect(again.settingFor("/code/app")).toEqual({ enabled: true, intervalMinutes: 5, shipOnGreen: false });
    expect(again.settingFor("/code/other")).toEqual({ enabled: false, intervalMinutes: 15, shipOnGreen: false });
    expect(disk.docs.has(LEAD_TICK_DOC_KEY)).toBe(true);
  });

  it("changes one switch without touching the others", async () => {
    const store = createLeadTickStore(memoryDisk());
    await store.writeSetting("/code/app", { enabled: true, intervalMinutes: 30 });
    await store.writeSetting("/code/app", { shipOnGreen: true });
    expect(store.settingFor("/code/app")).toEqual({ enabled: true, intervalMinutes: 30, shipOnGreen: true });
  });

  it("writes on top of another window's change", async () => {
    const disk = memoryDisk();
    const one = createLeadTickStore(disk);
    const two = createLeadTickStore(disk);
    await one.load();
    await two.load();
    await one.writeSetting("/code/a", { enabled: true });
    await two.writeSetting("/code/b", { enabled: true });
    await one.refresh();
    expect(one.settingFor("/code/a").enabled).toBe(true);
    expect(one.settingFor("/code/b").enabled).toBe(true);
  });

  it("reads a bad document as all off", async () => {
    const disk = memoryDisk({ [LEAD_TICK_DOC_KEY]: { settings: { "/code/a": "on" }, runs: 7 } });
    const store = createLeadTickStore(disk);
    await store.load();
    expect(store.settingFor("/code/a").enabled).toBe(false);
    expect(store.runFor("/code/a")).toBeUndefined();
  });

  it("records a tick and keeps the noted keys capped at the limit, newest kept", async () => {
    const store = createLeadTickStore(memoryDisk());
    const noted = Array.from({ length: NOTED_LIMIT + 30 }, (_, i) => `k${i}`);
    await store.recordRun("/code/a", { at: 1_000, line: "Nothing to do.", noted });
    const run = store.runFor("/code/a");
    expect(run?.lastTickAt).toBe(1_000);
    expect(run?.lastLine).toBe("Nothing to do.");
    expect(run?.noted.length).toBe(NOTED_LIMIT);
    expect(run?.noted.at(-1)).toBe(`k${NOTED_LIMIT + 29}`);
  });
});
