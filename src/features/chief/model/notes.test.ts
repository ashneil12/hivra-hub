import { describe, expect, it } from "vitest";
import { noteDecision } from "./notes";

describe("decisions.note", () => {
  it("writes the first mate's own chat, not a chat named in the call", () => {
    const row = noteDecision({
      project: "hivra",
      what: "Example: merge on green",
      reason: "the checks passed",
      sessionId: "lead-1",
    });
    expect(row).toEqual({
      project: "hivra",
      session: "lead-1",
      what: "Example: merge on green",
      reason: "the checks passed",
      answeredBy: "chat:lead-1",
    });
    expect(row.answeredBy).not.toContain("captain:");
  });

  it("refuses a person-only key, and an empty reason", () => {
    expect(() => noteDecision({ project: "hivra", what: "secret/token", reason: "because", sessionId: "lead-1" })).toThrow(/owner/);
    expect(() => noteDecision({ project: "hivra", what: "Ｓecret/token", reason: "because", sessionId: "lead-1" })).toThrow(/owner/);
    expect(() => noteDecision({ project: "hivra", what: "Example: retry once", reason: "  ", sessionId: "lead-1" })).toThrow(/reason/i);
    expect(() => noteDecision({ project: " ", what: "Example: retry once", reason: "because", sessionId: "lead-1" })).toThrow(/project/i);
  });
});
