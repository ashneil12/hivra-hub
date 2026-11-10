// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_CATEGORIES } from "./notificationPreferences";
import {
  QUIET_HOURS_KEY,
  allowsProgrammeNotification,
  defaultQuietHours,
  isQuietHour,
  loadQuietHours,
  parseQuietHours,
  saveQuietHours,
} from "./quietHours";

/** Local wall time on a fixed day. Seconds stay off the minute boundary. */
function at(hour: number, minute: number): number {
  return new Date(2026, 10, 10, hour, minute, 30).getTime();
}

const NIGHT = at(23, 30);
const DAY = at(12, 0);

beforeEach(() => localStorage.clear());

describe("quiet hours setting", () => {
  it("starts off, with an overnight window, when nothing is stored", () => {
    expect(loadQuietHours()).toEqual({
      enabled: false,
      start: "22:00",
      end: "08:00",
    });
    expect(defaultQuietHours()).toEqual(loadQuietHours());
  });

  it("repairs values read from disk instead of trusting them", () => {
    for (const value of [null, "nope", [], 4, { enabled: "yes", start: "22:00", end: "08:00" }]) {
      expect(parseQuietHours(value)).toEqual({
        enabled: false,
        start: "22:00",
        end: "08:00",
      });
    }
    for (const start of ["24:00", "8:00", "22:60", "", "22:00:99"]) {
      expect(parseQuietHours({ enabled: true, start, end: "08:00" })).toEqual({
        enabled: true,
        start: "22:00",
        end: "08:00",
      });
    }
    expect(parseQuietHours({ enabled: true })).toEqual({
      enabled: true,
      start: "22:00",
      end: "08:00",
    });
    expect(
      parseQuietHours({ enabled: true, start: " 23:15:00 ", end: "07:00\r" }),
    ).toEqual({ enabled: true, start: "23:15", end: "07:00" });
    expect(
      parseQuietHours({ enabled: false, start: "21:00", end: "06:30", extra: 1 }),
    ).toEqual({ enabled: false, start: "21:00", end: "06:30" });
  });

  it("keeps the last good window when storage cannot be read or written", () => {
    saveQuietHours({ enabled: true, start: "21:00", end: "07:00" });
    expect(loadQuietHours()).toEqual({
      enabled: true,
      start: "21:00",
      end: "07:00",
    });
    expect(localStorage.getItem(QUIET_HOURS_KEY)).toContain("21:00");

    saveQuietHours({ enabled: true, start: "nope", end: "08:00" });
    expect(loadQuietHours()).toEqual({
      enabled: true,
      start: "22:00",
      end: "08:00",
    });

    const stored = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });
    expect(loadQuietHours()).toEqual(defaultQuietHours());
    expect(
      saveQuietHours({ enabled: true, start: "23:00", end: "08:00" }),
    ).toEqual({ enabled: true, start: "23:00", end: "08:00" });
    vi.stubGlobal("localStorage", stored);
    expect(loadQuietHours()).toEqual({
      enabled: true,
      start: "22:00",
      end: "08:00",
    });
  });
});

describe("quiet hours window", () => {
  const overnight = { enabled: true, start: "22:00", end: "08:00" };
  const daytime = { enabled: true, start: "09:00", end: "17:00" };

  it("covers a window that passes midnight, and ends on the end minute", () => {
    expect(isQuietHour(at(22, 0), overnight)).toBe(true);
    expect(isQuietHour(at(23, 30), overnight)).toBe(true);
    expect(isQuietHour(at(0, 0), overnight)).toBe(true);
    expect(isQuietHour(at(7, 59), overnight)).toBe(true);
    expect(isQuietHour(at(8, 0), overnight)).toBe(false);
    expect(isQuietHour(at(21, 59), overnight)).toBe(false);
  });

  it("covers a window on the same day", () => {
    expect(isQuietHour(at(9, 0), daytime)).toBe(true);
    expect(isQuietHour(at(16, 59), daytime)).toBe(true);
    expect(isQuietHour(at(17, 0), daytime)).toBe(false);
    expect(isQuietHour(at(8, 59), daytime)).toBe(false);
  });

  it("is off when disabled, when the window is empty, or when the clock is unusable", () => {
    expect(isQuietHour(NIGHT, { ...overnight, enabled: false })).toBe(false);
    expect(isQuietHour(NIGHT, { enabled: true, start: "08:00", end: "08:00" })).toBe(
      false,
    );
    expect(isQuietHour(NIGHT, { enabled: true, start: "nope", end: "08:00" })).toBe(
      false,
    );
    expect(isQuietHour(Number.NaN, overnight)).toBe(false);
    expect(isQuietHour(Number.POSITIVE_INFINITY, overnight)).toBe(false);
  });
});

describe("programme notices during quiet hours", () => {
  const quiet = { enabled: true, start: "22:00", end: "08:00" };

  function allowed(
    category: string,
    categoryMuted: boolean,
    now: number,
    hours = quiet,
  ): boolean {
    return allowsProgrammeNotification({
      category: category as "agentFinished",
      categoryMuted,
      quiet: hours,
      now,
    });
  }

  it("holds routine categories and still shows approvals unless that category is muted", () => {
    const routine = NOTIFICATION_CATEGORIES.map((item) => item.id).filter(
      (id) => id !== "agentInput",
    );
    expect(routine).toEqual([
      "pullRequests",
      "issues",
      "agentFinished",
      "reminders",
    ]);
    for (const category of routine) {
      expect(allowed(category, false, NIGHT)).toBe(false);
      expect(allowed(category, false, DAY)).toBe(true);
      expect(allowed(category, true, DAY)).toBe(false);
    }
    expect(allowed("agentInput", false, NIGHT)).toBe(true);
    expect(allowed("agentInput", true, NIGHT)).toBe(false);
    expect(allowed("agentInput", true, DAY)).toBe(false);
    expect(allowed("agentInput", false, DAY)).toBe(true);
    expect(allowed("something-else", false, NIGHT)).toBe(false);
    expect(
      allowed("agentFinished", false, NIGHT, { ...quiet, enabled: false }),
    ).toBe(true);
  });
});
