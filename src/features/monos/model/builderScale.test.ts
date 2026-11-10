import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILDER_SCALE,
  HEALTH_STALE_MS,
  builderLaunchAllowed,
  builderScaleToStored,
  sanitizeBuilderScale,
  scaleLine,
  type BuilderHealth,
  type BuilderScale,
} from "./builderScale";

describe("sanitizeBuilderScale", () => {
  it("keeps today's ceiling of 6 and leaves memory and disk off when nothing is stored", () => {
    for (const raw of [undefined, null, "nope", [], 4, true]) {
      expect(sanitizeBuilderScale(raw)).toEqual(DEFAULT_BUILDER_SCALE);
    }
    expect(DEFAULT_BUILDER_SCALE.maxBuilders).toBe(6);
    expect(DEFAULT_BUILDER_SCALE.load).toEqual({ kind: "default" });
    expect(DEFAULT_BUILDER_SCALE.pauseFreeMemoryGb).toBeNull();
    expect(DEFAULT_BUILDER_SCALE.pauseFreeDiskGb).toBeNull();
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
    expect(sanitizeBuilderScale({ pauseFreeDiskGb: 1e12 }).pauseFreeDiskGb).toBeNull();
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
    expect(Object.keys(stored!).sort()).toEqual(["load", "maxBuilders", "pauseFreeDiskGb", "pauseFreeMemoryGb"]);
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
