import { describe, expect, it } from "vitest";
import { briefLine, crewBriefLines } from "./briefLine";

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

  it("still has a line when a brief is only done or only paused", () => {
    expect(
      crewBriefLines("lead", [
        { id: "brief", ownerSession: "lead", follow: "lead", title: "Fix the save bug", status: "done", createdAt: 1 },
        { id: "w", parentId: "brief", ownerSession: "lead", status: "done" },
        { id: "other", ownerSession: "someone", follow: "lead", title: "Not mine", createdAt: 0 },
      ]),
    ).toEqual([{ id: "brief", text: "Fix the save bug: 1 done" }]);
    expect(
      crewBriefLines("lead", [
        { id: "brief", ownerSession: "lead", follow: "lead", title: "Wait", status: "paused" },
        { id: "w", parentId: "brief", status: "paused" },
      ])[0]?.text,
    ).toBe("Wait: 1 paused");
    expect(crewBriefLines("  ", [{ id: "brief", ownerSession: "lead", follow: "lead" }])).toEqual([]);
  });

  it("uses the first line, and a stand-in when the title is empty", () => {
    expect(briefLine("  First\r\nSecond", [{ status: "paused" }])).toBe("First: 1 paused");
    expect(briefLine("   ", [])).toBe("This brief");
    expect(briefLine("x".repeat(200), [])).toBe("x".repeat(120));
  });
});

it("does not keep a cancelled duplicate in the active brief lines", () => {
  expect(crewBriefLines("example-lead", [
    { id: "original", ownerSession: "example-lead", follow: "lead", title: "Example: fix the chat", state: "running" },
    { id: "duplicate", ownerSession: "example-lead", follow: "lead", title: "Example: fix the chat", state: "cancelled" },
  ])).toEqual([{ id: "original", text: "Example: fix the chat" }]);
});
