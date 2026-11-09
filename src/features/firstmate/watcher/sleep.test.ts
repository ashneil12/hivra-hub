// WP-102 item 1: time the computer slept is not a worker's silence. A Mac suspends the app while its wall clock keeps
// going, so the first look after wake sees every running worker as hours silent. The look that arrives far later than
// its interval moves each running worker's clock forward by the gap and judges nothing that one time.
import { describe, expect, it } from "vitest";
import { classify, classifyLook, SILENCE_MS, SLEEP_TICKS, sleepGap, type Decision, type RowFacts, type WatchEvent } from "./classifier";
import type { Presence, WorkerLook } from "./stall";

const MIN = 60_000;
const TICK = 30_000;

const row = (over: Partial<RowFacts> = {}): RowFacts => ({
  id: "t1",
  ownerSession: "lead",
  childSession: "w1",
  generation: 1,
  state: "running",
  title: "Fix the save bug",
  ...over,
});
const busy = (over: Partial<WorkerLook> = {}): WorkerLook => ({
  busy: true,
  asking: false,
  queued: false,
  limited: false,
  resumeStopped: false,
  steps: 3,
  ...over,
});
const presence = (lastChangeAt: number): Presence => ({ watchedSince: 0, lastChangeAt, lastProgressAt: lastChangeAt, steps: 3 });
const look = (r: RowFacts, p: Presence, extra: Partial<Extract<WatchEvent, { kind: "look" }>> = {}): WatchEvent => ({
  kind: "look",
  row: r,
  look: busy(),
  presence: p,
  waitsOnWorkers: false,
  ...extra,
});
const kinds = (decisions: Decision[]) => decisions.map((d) => d.kind);

describe("sleepGap", () => {
  it("forgives only a gap wider than three tick intervals, and only the time over the interval itself", () => {
    expect(sleepGap(TICK, TICK)).toBe(0);
    expect(sleepGap(2 * TICK, TICK)).toBe(0);
    expect(sleepGap(SLEEP_TICKS * TICK, TICK)).toBe(0); // exactly three intervals is still an ordinary late tick
    // Three hours asleep: everything over one interval is forgiven, so the tick's own interval still counts.
    expect(sleepGap(3 * 60 * MIN, TICK)).toBe(3 * 60 * MIN - TICK);
    // A custom tick length does not change the rule: the gap must beat three intervals whatever they are.
    expect(sleepGap(10_000, 1_000)).toBe(9_000);
    expect(sleepGap(0, TICK)).toBe(0);
  });
});

describe("classifyLook after the computer slept", () => {
  it("a 3 hour gap between looks stops nobody, however silent the worker looked before it", () => {
    const silent = row({ stallKind: "quiet", stallReason: "", stalledAt: 0 });
    // The worker last moved at 0; the computer then slept 3 hours before this look.
    const at = 3 * 60 * MIN;
    expect(kinds(classifyLook(look(silent, presence(0)), at, SILENCE_MS, { sleptMs: 3 * 60 * MIN - TICK }))).toEqual(["record"]);
  });

  it("the clock is forgiven only for the gap: the look before it still stops a worker that had been silent 20 minutes", () => {
    // Without a sleep, 20 minutes of silence stops it.
    expect(kinds(classifyLook(look(row(), presence(0)), 20 * MIN, SILENCE_MS))).toEqual(["stop"]);
    // With a sleep the look itself judges nothing, even though the wall clock now says hours.
    expect(kinds(classifyLook(look(row(), presence(0)), 3 * 60 * MIN, SILENCE_MS, { sleptMs: 3 * 60 * MIN - TICK }))).toEqual(["record"]);
  });

  it("a worker that goes silent after the wake is still stopped 20 minutes later, not at the wake", () => {
    // The clock was moved forward by the sleep: the worker's last change reads as the wake time (3 h in).
    const woke = 3 * 60 * MIN;
    const after = presence(woke);
    // 19 minutes after waking: not silent yet.
    expect(kinds(classifyLook(look(row(), after), woke + 19 * MIN, SILENCE_MS, { sleptMs: 0 }))).not.toContain("stop");
    // 20 minutes after waking, with no word since: stopped, as any other stretch.
    expect(kinds(classifyLook(look(row(), after), woke + 20 * MIN, SILENCE_MS, { sleptMs: 0 }))).toEqual(["stop"]);
  });

  it("the one look after a sleep records neither a stall notice nor a stop", () => {
    const decided = classifyLook(look(row(), presence(0)), 3 * 60 * MIN, SILENCE_MS, { sleptMs: 3 * 60 * MIN - TICK });
    expect(decided).toEqual([{ kind: "record", reason: "the computer slept; the clock moved forward" }]);
  });

  it("an ordinary late look of a few intervals still judges as before (a 45 second tick is not a sleep)", () => {
    expect(kinds(classifyLook(look(row(), presence(0)), 20 * MIN, SILENCE_MS, { sleptMs: 0 }))).toEqual(["stop"]);
  });

  it("classify passes the sleep through a whole event", () => {
    expect(kinds(classify(look(row(), presence(0)), 3 * 60 * MIN, SILENCE_MS, { sleptMs: 3 * 60 * MIN - TICK }))).toEqual(["record"]);
  });
});
