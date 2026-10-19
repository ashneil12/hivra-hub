import { describe, expect, it } from "vitest";
import { formatRemaining, formatUntil, parseUntil, untilPresets } from "./endTime";

// Saturday 17 Oct 2026, 15:00 local time: Ash heading off for the weekend.
const SAT = new Date(2026, 9, 17, 15, 0).getTime();
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

describe("autopilot end times", () => {
  it("reads Ash's words in the Mac's time zone", () => {
    expect(parseUntil("until Monday 9:00", SAT)).toBe(local(19, 9));
    expect(parseUntil("go autopilot until monday 9am", SAT)).toBe(local(19, 9));
    expect(parseUntil("till Mon 9", SAT)).toBe(local(19, 9));
    expect(parseUntil("monday", SAT)).toBe(local(19, 9));
    expect(parseUntil("next monday at 10:30", SAT)).toBe(local(19, 10, 30));
    expect(parseUntil("tomorrow 6pm", SAT)).toBe(local(18, 18));
    expect(parseUntil("tomorrow", SAT)).toBe(local(18, 9));
    expect(parseUntil("tonight", SAT)).toBe(local(17, 23));
    expect(parseUntil("18:30", SAT)).toBe(local(17, 18, 30));
    // A clock time already past today means tomorrow's.
    expect(parseUntil("9:00", SAT)).toBe(local(18, 9));
    expect(parseUntil("noon", SAT)).toBe(local(18, 12));
  });

  it("reads spans and ISO times", () => {
    expect(parseUntil("for 8 hours", SAT)).toBe(SAT + 8 * 3_600_000);
    expect(parseUntil("in 90 minutes", SAT)).toBe(SAT + 90 * 60_000);
    expect(parseUntil("2 days", SAT)).toBe(SAT + 2 * 86_400_000);
    expect(parseUntil("2026-10-19T09:00:00Z", SAT)).toBe(Date.parse("2026-10-19T09:00:00Z"));
    expect(parseUntil("2026-10-19", SAT)).toBe(local(19, 9));
  });

  it("a weekday said on that same day means next week's", () => {
    const monday = local(19, 8);
    expect(parseUntil("monday 9:00", monday)).toBe(local(26, 9));
  });

  it("refuses what it can't read", () => {
    for (const bad of ["", "whenever", "monday 25:00", "13pm", "until the cows come home"]) {
      expect(parseUntil(bad, SAT), bad).toBeNull();
    }
  });

  it("says the end time the short way", () => {
    expect(formatUntil(local(17, 18, 5), SAT)).toBe("18:05");
    expect(formatUntil(local(18, 9), SAT)).toBe("tomorrow 9:00");
    expect(formatUntil(local(19, 9), SAT)).toBe("Mon 9:00");
    expect(formatUntil(local(30, 9), SAT)).toBe("30 Oct 9:00");
    expect(formatRemaining(SAT + 42 * 60_000, SAT)).toBe("42m");
    expect(formatRemaining(SAT + 130 * 60_000, SAT)).toBe("2h 10m");
    expect(formatRemaining(SAT + 66 * 3_600_000, SAT)).toBe("3 days");
  });

  it("offers one-tap end times, without repeats", () => {
    expect(untilPresets(SAT).map((p) => p.label)).toEqual(["For 8 hours", "Until tomorrow 9:00", "Until Monday 9:00"]);
    const sunday = local(18, 12);
    expect(untilPresets(sunday).map((p) => p.label)).toEqual(["For 8 hours", "Until tomorrow 9:00"]);
  });
});
