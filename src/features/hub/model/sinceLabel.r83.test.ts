// r83: Today's clock is Ash's local time (Europe/London), not UTC, including in summer time.
import { describe, expect, it } from "vitest";
import { sinceLabel } from "./hubData";

describe("Today's Since reads Europe/London", () => {
  it("in British Summer Time 13:30 UTC is 2:30pm in London, 1:30pm in UTC", () => {
    const now = new Date("2026-07-01T18:00:00Z");
    expect(sinceLabel("2026-07-01T13:30:00Z", now, "Europe/London")).toBe("Since 2:30pm");
    expect(sinceLabel("2026-07-01T13:30:00Z", now, "UTC")).toBe("Since 1:30pm");
  });
  it("in winter (GMT) London and UTC agree, and the day turns at London's midnight", () => {
    const now = new Date("2026-10-30T01:20:00Z");
    expect(sinceLabel("2026-10-30T00:56:00Z", now, "Europe/London")).toBe("Since 12:56am");
    expect(sinceLabel("2026-10-29T23:30:00Z", now, "Europe/London")).toBe("Since yesterday");
    // 23:30 UTC on 1 July is 00:30 on 2 July in London: same day as 09:00 London.
    expect(sinceLabel("2026-07-01T23:30:00Z", new Date("2026-07-02T08:00:00Z"), "Europe/London")).toBe("Since 12:30am");
  });
  it("with no zone named it follows the Mac's own clock", () => {
    const at = new Date("2026-07-01T13:30:00Z");
    const own = sinceLabel(at.toISOString(), new Date("2026-07-01T18:00:00Z"));
    const h = at.getHours();
    expect(own).toBe(`Since ${h % 12 || 12}:30${h < 12 ? "am" : "pm"}`);
  });
});
