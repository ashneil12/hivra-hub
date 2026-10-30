// r94 (Critiquito g): "Nothing needs you" only, never doubled with "No questions are waiting".
import { describe, expect, it } from "vitest";
import { withoutDoubledAllClear } from "./allClear";
import { turnCopyText } from "../../features/sessions/model/transcriptActivity";

describe("withoutDoubledAllClear", () => {
  it.each([
    ["Nothing needs you. No questions are waiting.", "Nothing needs you."],
    ["Tally is green. Nothing needs you. No questions are waiting. I'll ping you when the PR is up.", "Tally is green. Nothing needs you. I'll ping you when the PR is up."],
    ["Nothing needs you right now, no questions pending.", "Nothing needs you right now."],
    ["Nothing needs you. No decisions are waiting on you.", "Nothing needs you."],
    ["Nothing needs you yet. No approvals pending", "Nothing needs you yet."],
  ])("%s", (input, want) => expect(withoutDoubledAllClear(input)).toBe(want));

  it("leaves other replies and code alone", () => {
    expect(withoutDoubledAllClear("No questions are waiting.")).toBe("No questions are waiting.");
    expect(withoutDoubledAllClear("Nothing needs you. The tests pass.")).toBe("Nothing needs you. The tests pass.");
    const fenced = "```\nNothing needs you. No questions are waiting.\n```";
    expect(withoutDoubledAllClear(fenced)).toBe(fenced);
  });
});

it("Copy and the rendered reply both say it once", () => {
  const blocks = [{ id: "a", role: "assistant" as const, text: "Nothing needs you. No questions are waiting." }];
  expect(turnCopyText(blocks)).toBe("Nothing needs you.");
});
