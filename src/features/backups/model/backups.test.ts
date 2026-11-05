import { describe, expect, it } from "vitest";
import {
  applySettingsResult,
  backupWhen,
  claimSettingsChange,
  restoredTitle,
  scheduleLabel,
} from "./backups";

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

  it("drops a late schedule change and ignores a second click", () => {
    const first = claimSettingsChange({ generation: 0, busy: false });
    expect(first).toEqual({ generation: 1, busy: true });
    expect(claimSettingsChange(first!)).toBeNull();
    const newer = { generation: 2, busy: true };
    const status = { schedule: "daily" as const, folder: "/tmp/backups", folderIsDefault: true };
    expect(applySettingsResult(newer, 1, status, { schedule: "hourly" })).toBeNull();
    const applied = applySettingsResult(newer, 2, status, { schedule: "off" });
    expect(applied?.status.schedule).toBe("off");
    expect(applied?.state.busy).toBe(false);
    expect(applied?.state.generation).toBe(2);
  });
});
