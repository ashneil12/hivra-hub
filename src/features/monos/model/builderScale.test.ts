import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILDER_SCALE,
  DEFAULT_FREE_DISK_GB,
  FREE_UP_SPACE,
  HEALTH_STALE_MS,
  builderHoldNeed,
  builderLaunchAllowed,
  builderScaleFromStored,
  builderScaleIsDefault,
  builderScaleToStored,
  diskHold,
  sanitizeBuilderScale,
  scaleLine,
  type BuilderHealth,
  type BuilderScale,
} from "./builderScale";

describe("sanitizeBuilderScale", () => {
  it("keeps today's ceiling of 6, leaves memory off and the disk pause on at 30 GB when nothing is stored", () => {
    for (const raw of [undefined, null, "nope", [], 4, true]) {
      expect(sanitizeBuilderScale(raw)).toEqual(DEFAULT_BUILDER_SCALE);
    }
    expect(DEFAULT_BUILDER_SCALE.maxBuilders).toBe(6);
    expect(DEFAULT_BUILDER_SCALE.load).toEqual({ kind: "default" });
    expect(DEFAULT_BUILDER_SCALE.pauseFreeMemoryGb).toBeNull();
    expect(DEFAULT_BUILDER_SCALE.pauseFreeDiskGb).toBe(30);
    expect(DEFAULT_FREE_DISK_GB).toBe(30);
    // The disk pause is on unless it is told otherwise: a scale that does not mention it keeps it on.
    expect(sanitizeBuilderScale({ maxBuilders: 12 }).pauseFreeDiskGb).toBe(30);
  });

  it("keeps a disk floor a person chose, and reads null, blank, false and 0 as off", () => {
    expect(sanitizeBuilderScale({ pauseFreeDiskGb: 50 }).pauseFreeDiskGb).toBe(50);
    expect(sanitizeBuilderScale({ pauseFreeDiskGb: "12" }).pauseFreeDiskGb).toBe(12);
    for (const off of [null, "", false, 0]) {
      expect(sanitizeBuilderScale({ pauseFreeDiskGb: off }).pauseFreeDiskGb).toBeNull();
    }
    // Garbage is not a choice to turn it off: it falls back to the default.
    for (const bad of ["lots", -3, Number.NaN, 1e12, {}, true]) {
      expect(sanitizeBuilderScale({ pauseFreeDiskGb: bad }).pauseFreeDiskGb).toBe(30);
    }
  });

  it("clamps the ceiling and drops a pause that is not a real threshold", () => {
    expect(sanitizeBuilderScale({ maxBuilders: 0 }).maxBuilders).toBe(1);
    expect(sanitizeBuilderScale({ maxBuilders: -4 }).maxBuilders).toBe(1);
    expect(sanitizeBuilderScale({ maxBuilders: 1.2 }).maxBuilders).toBe(1);
    expect(sanitizeBuilderScale({ maxBuilders: 20.6 }).maxBuilders).toBe(21);
    expect(sanitizeBuilderScale({ maxBuilders: 100 }).maxBuilders).toBe(30);
    expect(sanitizeBuilderScale({ maxBuilders: Number.NaN }).maxBuilders).toBe(6);
    expect(sanitizeBuilderScale({ maxBuilders: Number.POSITIVE_INFINITY }).maxBuilders).toBe(6);
    expect(sanitizeBuilderScale({ maxBuilders: "12" }).maxBuilders).toBe(12);
    expect(sanitizeBuilderScale({ maxBuilders: "  " }).maxBuilders).toBe(6);
    expect(sanitizeBuilderScale({ pauseFreeMemoryGb: 0 }).pauseFreeMemoryGb).toBeNull();
    expect(sanitizeBuilderScale({ pauseFreeMemoryGb: -1 }).pauseFreeMemoryGb).toBeNull();
    expect(sanitizeBuilderScale({ pauseFreeMemoryGb: "4" }).pauseFreeMemoryGb).toBe(4);
    expect(sanitizeBuilderScale({ pauseFreeMemoryGb: "4gb" }).pauseFreeMemoryGb).toBeNull();
    expect(sanitizeBuilderScale({ pauseFreeDiskGb: "" }).pauseFreeDiskGb).toBeNull();
    expect(sanitizeBuilderScale({ pauseFreeDiskGb: 1e12 }).pauseFreeDiskGb).toBe(30);
    expect(sanitizeBuilderScale({ load: "off" }).load).toEqual({ kind: "off" });
    expect(sanitizeBuilderScale({ load: false }).load).toEqual({ kind: "off" });
    expect(sanitizeBuilderScale({ load: { kind: "above", value: 0 } }).load).toEqual({ kind: "default" });
    expect(sanitizeBuilderScale({ load: { kind: "above", value: 3.25 } }).load).toEqual({ kind: "above", value: 3.25 });
    expect(sanitizeBuilderScale({ load: { above: 8 } }).load).toEqual({ kind: "above", value: 8 });
    expect(sanitizeBuilderScale({ load: { kind: "nope" } }).load).toEqual({ kind: "default" });
    expect(sanitizeBuilderScale({ pauseLoad: 8 }).load).toEqual({ kind: "above", value: 8 });
  });

  it("ignores extra fields", () => {
    const clean = sanitizeBuilderScale({ maxBuilders: 8, load: "off", extra: "x", pauseFreeMemoryGb: "low" });
    expect(clean).toEqual({ ...DEFAULT_BUILDER_SCALE, maxBuilders: 8, load: { kind: "off" } });
    expect(clean).not.toHaveProperty("extra");
  });

  it("stores only the ceiling and the pauses, never a list of builders to stop", () => {
    const stored = builderScaleToStored(
      sanitizeBuilderScale({ maxBuilders: 20, load: "off", pauseFreeMemoryGb: 2, pauseFreeDiskGb: 5 }),
    );
    expect(stored).not.toBeNull();
    expect(Object.keys(stored!).sort()).toEqual([
      "load",
      "maxBuilders",
      "pauseFreeDiskGb",
      "pauseFreeMemoryGb",
      "version",
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/kill|stop|pid/i);
    expect(builderScaleToStored(DEFAULT_BUILDER_SCALE)).toBeNull();
  });

  it("says each pause in plain words, including that running builders keep going", () => {
    const line = scaleLine({
      maxBuilders: 20,
      load: { kind: "above", value: 12 },
      pauseFreeMemoryGb: 2,
      pauseFreeDiskGb: null,
    });
    expect(line).toContain("above 12");
    expect(line).toContain("below 2 GB");
    expect(line).toContain("Free disk is not checked.");
    expect(line).toContain("Running builders keep going.");
    expect(line).not.toMatch(/[—–]/);
    expect(scaleLine(DEFAULT_BUILDER_SCALE)).toContain("1.6 times the number of cores");
    expect(scaleLine(DEFAULT_BUILDER_SCALE)).toContain("New builders pause when free disk is below 30 GB.");
    expect(scaleLine({ ...DEFAULT_BUILDER_SCALE, load: { kind: "off" } })).toContain("Load is not checked.");
  });
});

const hot: BuilderHealth = { load1: 20, cores: 8, freeMemoryGb: 0.5, freeDiskGb: 1 };
const cool: BuilderHealth = { load1: 1, cores: 8, freeMemoryGb: 16, freeDiskGb: 40 };

describe("builderLaunchAllowed", () => {
  it("allows a launch when the machine is inside every pause, including a reading that sits on the line", () => {
    const limits: BuilderScale = {
      maxBuilders: 6,
      load: { kind: "above", value: 4 },
      pauseFreeMemoryGb: 2,
      pauseFreeDiskGb: 5,
    };
    expect(builderLaunchAllowed(cool, limits)).toEqual({ ok: true, reason: "" });
    expect(builderLaunchAllowed({ load1: 4, cores: 8, freeMemoryGb: 2, freeDiskGb: 5 }, limits).ok).toBe(true);
    expect(builderLaunchAllowed(undefined, limits).ok).toBe(true);
    expect(builderLaunchAllowed(null, limits).ok).toBe(true);
    expect(builderLaunchAllowed({}, limits).ok).toBe(true);
  });

  it("pauses on load, and skips that check when the reading or the core count is missing", () => {
    const paused = builderLaunchAllowed(
      { load1: 6.41, cores: 4 },
      { ...DEFAULT_BUILDER_SCALE, maxBuilders: 20 },
    );
    expect(paused.ok).toBe(false);
    if (paused.ok) return;
    expect(paused.reason).toContain("exceeds");
    expect(paused.reason).toContain("6.4");
    expect(paused.reason).toContain("Running builders keep going.");
    expect(paused.reason).not.toMatch(/[—–]/);
    expect(paused.reason).not.toMatch(/kill|pid/i);
    // On the line, and with the default check but no core count, a launch is allowed.
    expect(builderLaunchAllowed({ load1: 6.4, cores: 4 }, DEFAULT_BUILDER_SCALE).ok).toBe(true);
    expect(builderLaunchAllowed({ load1: 100 }, DEFAULT_BUILDER_SCALE).ok).toBe(true);
    expect(builderLaunchAllowed({ load1: 100, cores: 0 }, DEFAULT_BUILDER_SCALE).ok).toBe(true);
    expect(builderLaunchAllowed({ load1: Number.NaN, cores: 4 }, DEFAULT_BUILDER_SCALE).ok).toBe(true);
    expect(
      builderLaunchAllowed({ load1: 100, cores: 4 }, { ...DEFAULT_BUILDER_SCALE, load: { kind: "off" } }).ok,
    ).toBe(true);
  });

  it("pauses when free memory or free disk is below its cutoff, and not when the reading is missing", () => {
    const memory = builderLaunchAllowed(
      { freeMemoryGb: 1.5, freeDiskGb: 40 },
      { ...DEFAULT_BUILDER_SCALE, load: { kind: "off" }, pauseFreeMemoryGb: 2 },
    );
    expect(memory.ok).toBe(false);
    if (!memory.ok) {
      expect(memory.reason).toContain("below");
      expect(memory.reason).toContain("2 GB");
      expect(memory.reason).toContain("Running builders keep going.");
    }
    const disk = builderLaunchAllowed(
      { freeMemoryGb: 16, freeDiskGb: 4.9 },
      { ...DEFAULT_BUILDER_SCALE, load: { kind: "off" }, pauseFreeDiskGb: 5 },
    );
    expect(disk.ok).toBe(false);
    if (!disk.ok) expect(disk.reason).toContain("Free disk");
    expect(
      builderLaunchAllowed(
        { freeDiskGb: 5 },
        { ...DEFAULT_BUILDER_SCALE, load: { kind: "off" }, pauseFreeDiskGb: 5 },
      ).ok,
    ).toBe(true);
    expect(
      builderLaunchAllowed(
        { load1: 1 },
        { ...DEFAULT_BUILDER_SCALE, load: { kind: "off" }, pauseFreeMemoryGb: 2, pauseFreeDiskGb: 5 },
      ).ok,
    ).toBe(true);
  });

  it("a higher max does not override a pause, and a stale reading is not a pause", () => {
    const raised = builderLaunchAllowed(hot, { ...DEFAULT_BUILDER_SCALE, maxBuilders: 20 });
    expect(raised.ok).toBe(false);
    if (!raised.ok) expect(raised.reason).toContain("exceeds");
    const stale = builderLaunchAllowed(
      { ...hot, readAt: 1_000, now: 1_000 + HEALTH_STALE_MS + 1 },
      { ...DEFAULT_BUILDER_SCALE, maxBuilders: 20, pauseFreeMemoryGb: 2, pauseFreeDiskGb: 5 },
    );
    expect(stale).toEqual({ ok: true, reason: "" });
    const fresh = builderLaunchAllowed(
      { load1: 9, cores: 4, readAt: 1_000, now: 1_000 + HEALTH_STALE_MS },
      DEFAULT_BUILDER_SCALE,
    );
    expect(fresh.ok).toBe(false);
    // No timestamp means the fixture is the reading, not a stale one.
    expect(builderLaunchAllowed(hot, DEFAULT_BUILDER_SCALE).ok).toBe(false);
  });

  it("names the load pause before memory or disk when more than one is crossed", () => {
    const both = builderLaunchAllowed(hot, {
      ...DEFAULT_BUILDER_SCALE,
      pauseFreeMemoryGb: 2,
      pauseFreeDiskGb: 5,
    });
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.reason).toContain("load average");
      expect(both.reason).not.toContain("Free memory");
    }
  });
});

describe("the disk pause is on by default at 30 GB", () => {
  const noLoad: BuilderScale = { ...DEFAULT_BUILDER_SCALE, load: { kind: "off" } };

  it("pauses at 29 GB free, and does not at 31 GB or right on the line", () => {
    const at29 = builderLaunchAllowed({ freeDiskGb: 29 }, DEFAULT_BUILDER_SCALE);
    expect(at29.ok).toBe(false);
    if (!at29.ok) {
      expect(at29.reason).toContain("Free disk is 29 GB");
      expect(at29.reason).toContain("below 30 GB");
      expect(at29.reason).toContain("Running builders keep going.");
    }
    expect(builderLaunchAllowed({ freeDiskGb: 31 }, DEFAULT_BUILDER_SCALE)).toEqual({ ok: true, reason: "" });
    expect(builderLaunchAllowed({ freeDiskGb: 30 }, DEFAULT_BUILDER_SCALE).ok).toBe(true);
    // Not a settings change: nothing was stored, this is the scale a fresh install has.
    expect(builderScaleToStored(DEFAULT_BUILDER_SCALE)).toBeNull();
    expect(builderLaunchAllowed({ freeDiskGb: 29 }, sanitizeBuilderScale(undefined)).ok).toBe(false);
  });

  it("can still be turned off or changed, and a missing reading is not a pause", () => {
    expect(builderLaunchAllowed({ freeDiskGb: 1 }, { ...noLoad, pauseFreeDiskGb: null }).ok).toBe(true);
    expect(builderLaunchAllowed({ freeDiskGb: 40 }, { ...noLoad, pauseFreeDiskGb: 50 }).ok).toBe(false);
    expect(builderLaunchAllowed({ freeDiskGb: 10 }, { ...noLoad, pauseFreeDiskGb: 5 }).ok).toBe(true);
    expect(builderLaunchAllowed({ load1: 1, cores: 8 }, DEFAULT_BUILDER_SCALE).ok).toBe(true);
    expect(builderLaunchAllowed({ freeDiskGb: null }, DEFAULT_BUILDER_SCALE).ok).toBe(true);
  });

  it("is a default only while it is 30: off or another floor is a setting to keep", () => {
    expect(builderScaleIsDefault(DEFAULT_BUILDER_SCALE)).toBe(true);
    expect(builderScaleIsDefault({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: null })).toBe(false);
    expect(builderScaleIsDefault({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: 20 })).toBe(false);
    expect(builderScaleToStored({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: null })).toEqual({
      version: 2,
      maxBuilders: 6,
      load: "default",
      pauseFreeMemoryGb: null,
      pauseFreeDiskGb: null,
    });
  });
});

describe("a stored scale from before the disk pause was on by default", () => {
  it("takes the new default when its disk pause was only never set", () => {
    const old = { maxBuilders: 12, load: "default", pauseFreeMemoryGb: null, pauseFreeDiskGb: null };
    expect(builderScaleFromStored(old)).toEqual({ ...DEFAULT_BUILDER_SCALE, maxBuilders: 12, pauseFreeDiskGb: 30 });
    // Missing, not just null.
    expect(builderScaleFromStored({ maxBuilders: 12 }).pauseFreeDiskGb).toBe(30);
    // Another old shape: a bare load and a memory pause, still no disk choice.
    expect(builderScaleFromStored({ load: { above: 8 }, pauseFreeMemoryGb: 2 })).toEqual({
      ...DEFAULT_BUILDER_SCALE,
      load: { kind: "above", value: 8 },
      pauseFreeMemoryGb: 2,
      pauseFreeDiskGb: 30,
    });
  });

  it("keeps a disk floor the person had chosen", () => {
    expect(builderScaleFromStored({ maxBuilders: 12, pauseFreeDiskGb: 5 }).pauseFreeDiskGb).toBe(5);
    expect(builderScaleFromStored({ maxBuilders: 12, pauseFreeDiskGb: 100 }).pauseFreeDiskGb).toBe(100);
  });

  it("keeps a deliberate off: a row saved by this version with a null stays off", () => {
    const stored = builderScaleToStored({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: null });
    expect(stored).not.toBeNull();
    expect(builderScaleFromStored(stored).pauseFreeDiskGb).toBeNull();
    // Through a JSON round trip, the way the store keeps it.
    expect(builderScaleFromStored(JSON.parse(JSON.stringify(stored))).pauseFreeDiskGb).toBeNull();
    const withMax = builderScaleToStored({ ...DEFAULT_BUILDER_SCALE, maxBuilders: 20, pauseFreeDiskGb: null });
    expect(builderScaleFromStored(withMax)).toEqual({ ...DEFAULT_BUILDER_SCALE, maxBuilders: 20, pauseFreeDiskGb: null });
    // Turning it back on writes a default scale (no row), which reads as on.
    expect(builderScaleToStored({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: 30 })).toBeNull();
    expect(builderScaleFromStored(undefined).pauseFreeDiskGb).toBe(30);
  });

  it("is never read as off because of how it was written: nothing, junk and a newer version are handled", () => {
    for (const raw of [undefined, null, "nope", [], 4]) {
      expect(builderScaleFromStored(raw)).toEqual(DEFAULT_BUILDER_SCALE);
    }
    expect(builderScaleFromStored({ version: 3, pauseFreeDiskGb: null }).pauseFreeDiskGb).toBeNull();
    expect(builderScaleFromStored({ version: 2 }).pauseFreeDiskGb).toBe(30);
    expect(builderScaleFromStored({ version: 2, pauseFreeDiskGb: "lots" }).pauseFreeDiskGb).toBe(30);
    expect(builderScaleFromStored({ version: "x", pauseFreeDiskGb: null }).pauseFreeDiskGb).toBe(30);
  });
});

describe("the Needs you line for builders held by the disk pause", () => {
  it("names the free space and the floor, with the action that frees space", () => {
    const need = builderHoldNeed(1, { freeDiskGb: 24 }, DEFAULT_BUILDER_SCALE);
    expect(need).toMatchObject({ id: "builders-disk", freeGb: 24, floorGb: 30, action: FREE_UP_SPACE });
    expect(need?.text).toBe("New builders are waiting: 24 GB free, under the 30 GB floor");
    expect(FREE_UP_SPACE).toBe("Free up space");
    expect(need?.text).not.toMatch(/[—–]/);
    expect(builderHoldNeed(3, { freeDiskGb: 12.5 }, { ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: 40 })?.text).toBe(
      "New builders are waiting: 12.5 GB free, under the 40 GB floor",
    );
  });

  it("rounds the free space down, so a reading under the floor never reads as the floor", () => {
    expect(builderHoldNeed(1, { freeDiskGb: 29.97 }, DEFAULT_BUILDER_SCALE)?.text).toBe(
      "New builders are waiting: 29.9 GB free, under the 30 GB floor",
    );
    expect(builderHoldNeed(1, { freeDiskGb: 24.37 }, DEFAULT_BUILDER_SCALE)?.text).toContain("24.3 GB free");
  });

  it("is there only while a builder waits and the disk is under the floor", () => {
    expect(builderHoldNeed(0, { freeDiskGb: 24 }, DEFAULT_BUILDER_SCALE)).toBeNull();
    expect(builderHoldNeed(1, { freeDiskGb: 31 }, DEFAULT_BUILDER_SCALE)).toBeNull();
    expect(builderHoldNeed(1, { freeDiskGb: 30 }, DEFAULT_BUILDER_SCALE)).toBeNull();
    expect(builderHoldNeed(1, {}, DEFAULT_BUILDER_SCALE)).toBeNull();
    expect(builderHoldNeed(1, undefined, DEFAULT_BUILDER_SCALE)).toBeNull();
    // Turned off: a low disk holds nothing, so there is nothing to say.
    expect(builderHoldNeed(2, { freeDiskGb: 1 }, { ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: null })).toBeNull();
    // A reading that is too old is not a hold, the same as for the launch gate.
    expect(
      builderHoldNeed(1, { freeDiskGb: 24, readAt: 1_000, now: 1_000 + HEALTH_STALE_MS + 1 }, DEFAULT_BUILDER_SCALE),
    ).toBeNull();
    expect(
      builderHoldNeed(1, { freeDiskGb: 24, readAt: 1_000, now: 1_000 + HEALTH_STALE_MS }, DEFAULT_BUILDER_SCALE),
    ).not.toBeNull();
  });

  it("still names the disk when the load is crossed too, because only the disk needs the person", () => {
    const both: BuilderHealth = { load1: 40, cores: 8, freeDiskGb: 24 };
    const decision = builderLaunchAllowed(both, DEFAULT_BUILDER_SCALE);
    expect(!decision.ok && decision.reason).toContain("load average");
    expect(diskHold(both, DEFAULT_BUILDER_SCALE)).toEqual({ freeGb: 24, floorGb: 30 });
    expect(builderHoldNeed(1, both, DEFAULT_BUILDER_SCALE)?.text).toContain("24 GB free");
  });
});
