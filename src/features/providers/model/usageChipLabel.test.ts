import { expect, it } from "vitest";
import { usageChipLabel } from "./rateLimits";
import { barClass } from "../ui/ProviderAccountUsage";

const now = Date.UTC(2026, 9, 15, 12);
const min = 60_000;

it("says what each number is: used, which window, and when it resets", () => {
  expect(usageChipLabel("session", { usedPercent: 3, windowMinutes: 300, resetsAt: now + 165 * min }, now)).toBe("5h: 3% used · resets in 2h 45m");
  expect(usageChipLabel("weekly", { usedPercent: 99, windowMinutes: 10080, resetsAt: now + (5 * 24 + 15) * 60 * min }, now)).toBe("Week: 99% used · resets in 5d 15h");
  expect(usageChipLabel("monthly", { usedPercent: 40, windowMinutes: 43200, resetsAt: null }, now)).toBe("Month: 40% used of mo");
  expect(usageChipLabel("session", { usedPercent: 20, windowMinutes: 1440, resetsAt: now - 1 }, now)).toBe("Today: 20% used · resets now");
  expect(usageChipLabel("weekly", { usedPercent: 99, windowMinutes: 10080, resetsAt: now + 60 * min }, now, true)).toBe("Week: 1% left · resets in 1h");
});

it("is red only near the limit", () => {
  expect(barClass(3)).toBe("bg-content/45");
  expect(barClass(79)).toBe("bg-content/45");
  expect(barClass(85)).toBe("bg-amber-400");
  expect(barClass(95)).toBe("bg-red-400");
});

it("puts the fullest window first", async () => {
  const { fullestFirst } = await import("../../../app/shell/UsageProviderChip");
  const w = (k: string, p: number) => ({ key: k, window: { usedPercent: p, windowMinutes: 300, resetsAt: null } });
  expect(fullestFirst([w("session", 3), w("weekly", 99)]).map((x) => x.key)).toEqual(["weekly", "session"]);
  expect(fullestFirst([w("session", 50), w("weekly", 50)]).map((x) => x.key)).toEqual(["session", "weekly"]);
});
