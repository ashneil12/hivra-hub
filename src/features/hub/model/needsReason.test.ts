// Port map idea 3: every Needs-you row says why from one fixed list (after Alan's Workspace HANDBACK_TEXT; ours is strict).
import { describe, expect, it } from "vitest";
import { NEEDS_REASONS, chatQuestion, needsReason, parseNeedsAsh } from "./chatQuestions";

const reasonOf = (text: string) => needsReason(chatQuestion({ busy: false, blocks: [{ role: "assistant", text }] })!);

describe("needsReason", () => {
  it("the list is exactly seven reasons (r65 adds provide something)", () => {
    expect([...NEEDS_REASONS]).toEqual(["sign in", "enter a code", "pay", "provide something", "pick an option", "approve a red-line step", "review"]);
  });

  it("reads the flag the agent wrote", () => {
    expect(reasonOf("Needs Ash (sign in): Log in to Vercel so I can deploy the preview?")).toBe("sign in");
    expect(reasonOf("Needs Ash (enter a code): Apple sent a code to your phone.")).toBe("enter a code");
    expect(reasonOf("Needs Ash (pay): Add a card to the Fly account.")).toBe("pay");
    expect(reasonOf("Needs Ash (review): Look over the new onboarding copy.")).toBe("review");
    expect(parseNeedsAsh("Needs Ash (sign in): Log in?")?.flag).toBe("sign in");
  });

  it("a red line is an approval; a pick or a live question is a choice; anything else is review", () => {
    expect(reasonOf("Needs Ash (red line): Email the waitlist about the delay?\nMy pick: Wait until Friday.")).toBe("approve a red-line step");
    expect(reasonOf("Needs Ash: Ship to production tonight?")).toBe("approve a red-line step");
    expect(reasonOf("Needs Ash: Replace the old parser now?\nMy pick: Keep both for a week.")).toBe("pick an option");
    expect(needsReason({ source: "ask", redLine: false })).toBe("pick an option");
    expect(reasonOf("Needs Ash: Something about the docs.")).toBe("review");
  });

  it("an unknown flag never invents a reason: it falls back like any other ask", () => {
    expect(reasonOf("Needs Ash (urgent): Something about the docs.")).toBe("review");
    expect(reasonOf("Needs Ash (urgent): Which name?\nMy pick: Nova.")).toBe("pick an option");
  });

  it("the agent's own words never replace the reason (always one of the six)", () => {
    for (const text of ["Needs Ash (whenever you can, no rush): Thoughts?", "Needs Ash: hmm"]) {
      expect(NEEDS_REASONS).toContain(reasonOf(text));
    }
  });
});
