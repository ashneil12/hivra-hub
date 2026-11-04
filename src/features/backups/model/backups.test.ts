import { describe, expect, it } from "vitest";
import { backupWhen, restoredTitle, scheduleLabel } from "./backups";

describe("backups", () => {
  it("always adds the restored ending, even to a title that already has it", () => {
    expect(restoredTitle("Ship plan")).toBe("Ship plan (restored)");
    expect(restoredTitle("Ship plan (restored)")).toBe("Ship plan (restored) (restored)");
    expect(restoredTitle("")).toBe(" (restored)");
  });

  it("names the three schedules and falls back to daily", () => {
    expect(scheduleLabel("off")).toBe("Off");
    expect(scheduleLabel("hourly")).toBe("Hourly");
    expect(scheduleLabel("daily")).toBe("Daily");
    expect(scheduleLabel("weekly")).toBe("Daily");
    expect(scheduleLabel("")).toBe("Daily");
  });

  it("prints a backup time in UTC", () => {
    expect(backupWhen(Date.UTC(2026, 10, 4, 12, 0, 0))).toBe("4 Nov 2026");
    expect(backupWhen(Number.NaN)).toBe("Unknown time");
  });
});
