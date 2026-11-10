import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILDER_SCALE,
  builderScaleToStored,
  sanitizeBuilderScale,
  scaleLine,
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
