// r84 (c02 blind 2): the claim check fired on the chat saving Ash's rule and on its own reply about the check, and his
// "hows it going" was held against the build as an ask.
import { describe, expect, it } from "vitest";
import { doneClaimOf, extractAsks } from "./askLedger";

describe("a done claim is work said to be done, not the word talked about", () => {
  it("skips the rule and the check named", () => {
    expect(doneClaimOf("Your rule is saved: npm test runs before anything is called done.")).toBeUndefined();
    expect(doneClaimOf("The check treats that sentence as a done claim.")).toBeUndefined();
    expect(doneClaimOf("Nothing is marked done until npm test passes.")).toBeUndefined();
  });
  it("still catches a real one", () => {
    expect(doneClaimOf("GET /health is done and its test passed.")).toBe("GET /health is done and its test passed.");
  });
});

it("a status question is not an ask", () => {
  expect(extractAsks("hows it going, anything need me")).toEqual([]);
});
