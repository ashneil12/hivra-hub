import { describe, expect, it } from "vitest";
import { briefLine } from "./briefLine";

describe("brief line", () => {
  it("counts only the five statuses, in order, and skips zeros", () => {
    expect(
      briefLine("Fix the save bug", [
        { status: "working" },
        { status: "working" },
        { status: "needs-you" },
        { status: "done" },
        { status: "cancelled" },
        { status: "stuck" },
        {},
      ]),
    ).toBe("Fix the save bug: 2 working, 1 needs you, 1 done");
  });

  it("does not invent a word when nobody has a status yet", () => {
    expect(briefLine("Fix the save bug", [{ status: "running" }, {}])).toBe("Fix the save bug");
    expect(briefLine("Fix the save bug", [])).toBe("Fix the save bug");
  });

  it("uses the first line, and a stand-in when the title is empty", () => {
    expect(briefLine("  First\r\nSecond", [{ status: "paused" }])).toBe("First: 1 paused");
    expect(briefLine("   ", [])).toBe("This brief");
    expect(briefLine("x".repeat(200), [])).toBe("x".repeat(120));
  });
});
