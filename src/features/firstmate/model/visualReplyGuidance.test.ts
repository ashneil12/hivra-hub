// WP-130 review, item 9: agents are told that a marked fence exists and that the person has to run it.
import { describe, expect, it } from "vitest";
import { FIRST_MATE_CONTRACT } from "./contract";

describe("agent guidance for visual replies", () => {
  it("names the visual fence, says it runs only when the person runs it, and says when to use it", () => {
    expect(FIRST_MATE_CONTRACT).toContain("```visual");
    expect(FIRST_MATE_CONTRACT).toMatch(/sandbox/);
    expect(FIRST_MATE_CONTRACT).toMatch(/person[^\n]*runs it with a click/);
    expect(FIRST_MATE_CONTRACT).not.toMatch(/[–—]/);
  });
});
