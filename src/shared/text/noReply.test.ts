import { describe, expect, it } from "vitest";
import { withoutNoReply } from "./noReply";

describe("withoutNoReply (r51: the raw NO_REPLY never shows)", () => {
  it("drops it on its own last line, as in frank's e02 message", () => {
    expect(withoutNoReply("CoS treated \"Ye go\" as not a lock. I'm checking Hub memory so a test doesn't sit there as a decision.\n\nNO_REPLY")).toBe(
      "CoS treated \"Ye go\" as not a lock. I'm checking Hub memory so a test doesn't sit there as a decision.",
    );
  });
  it("drops it alone, at the start, at the end of a line, or marked up", () => {
    expect(withoutNoReply("NO_REPLY")).toBe("");
    expect(withoutNoReply("  no_reply. ")).toBe("");
    expect(withoutNoReply("`NO_REPLY`")).toBe("");
    expect(withoutNoReply("NO_REPLY - nothing from me")).toBe("nothing from me");
    expect(withoutNoReply("All set. NO_REPLY")).toBe("All set.");
    expect(withoutNoReply("One.\nNO_REPLY\nTwo.")).toBe("One.\n\nTwo.");
  });
  it("leaves other text alone", () => {
    expect(withoutNoReply("Plain words.")).toBe("Plain words.");
    expect(withoutNoReply("")).toBe("");
  });
});
