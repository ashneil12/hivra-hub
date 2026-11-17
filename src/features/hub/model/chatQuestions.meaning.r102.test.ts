import { describe, expect, it } from "vitest";
import { asksByMeaning, plainQuestionToAsh } from "./chatQuestions";

describe("r102 (1): a question to Ash is known by its meaning, not only its '?'", () => {
  it("05bc: 'Still your call on …: A, or B.' becomes an ask", () => {
    const text = "Nothing went out.\n\nStill your call on the privacy page: have Tally draft it for you to OK, or leave all three parked.";
    expect(plainQuestionToAsh(text)).toBe("Still your call on the privacy page: have Tally draft it for you to OK, or leave all three parked");
  });
  it("'which', 'do you want', 'should I' with a full stop count", () => {
    expect(asksByMeaning("Do you want the short draft, or the long one.")).toBe(true);
    expect(asksByMeaning("Should I hold the reply until Monday.")).toBe(true);
    expect(asksByMeaning("Let me know which of the two you want.")).toBe(true);
    expect(asksByMeaning("It's up to you whether Stripe goes first.")).toBe(true);
  });
  it("a plain report is not an ask", () => {
    expect(plainQuestionToAsh("The hub fixes are in. Nothing was posted.")).toBeUndefined();
    expect(plainQuestionToAsh("I kept the short draft or the long one would not fit.")).toBeUndefined();
    expect(asksByMeaning("Chief of Staff made the call on DNS.")).toBe(false);
  });
  it("saying he is not asked is not an ask (a Needs-you card read 'Nothing needs your decision')", () => {
    const passed = "EXO lead counted README.md: 3 lines.\n\nThey confirmed it by reading the file. Nothing needs your decision.";
    expect(plainQuestionToAsh(passed)).toBeUndefined();
    expect(asksByMeaning("This doesn't need your call.")).toBe(false);
    expect(asksByMeaning("None of it needs your decision.")).toBe(false);
    expect(asksByMeaning("The colour is not your call.")).toBe(false);
    // The same words after something else was denied still ask.
    expect(asksByMeaning("Not done yet, and this needs your decision.")).toBe(true);
    expect(asksByMeaning("Nothing went out; still your call on the privacy page.")).toBe(true);
    expect(asksByMeaning("The draft is not ready and whether to ship is your call.")).toBe(true);
  });
  it("a '?' question still needs to be put to Ash", () => {
    expect(plainQuestionToAsh("Why did it fail? Nobody knows?")).toBeUndefined();
    expect(plainQuestionToAsh("Do you want the hub fixes first?")).toBe("Do you want the hub fixes first?");
  });
});
