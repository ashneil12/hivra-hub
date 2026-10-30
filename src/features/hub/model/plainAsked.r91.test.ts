import { describe, expect, it } from "vitest";
import { plainAskedLine } from "./plainAsked";

describe("r91 (Critiquito row 09): what a worker asked, in one plain line", () => {
  it("says what a blocked worker waits on, with no backticks, routes, JSON or hashes", () => {
    const a = plainAskedLine("Blocked. Ash has not signed off deleting a tally, so this does not ship. `DELETE /tallies/:id` currently hard-deletes and returns `200` `{ ok: true }` (`fc23fe1`). That picks one for you.");
    expect(a).toBe("Blocked until you sign off deleting a tally");
    const b = plainAskedLine("Blocked. Delete is built as a hard remove (204, row gone, file rewritten), but Ash has not signed that off. He still has to choose whether a deleted tally is gone for good or kept 30 days so last week's total can still read its old entries.");
    expect(b.startsWith("Blocked until you choose whether a deleted tally is gone for good or kept 30 days")).toBe(true);
    for (const line of [a, b]) {
      expect(line).not.toMatch(/`|\/tallies|\{|fc23fe1|\b200\b|\b204\b/);
      expect(line.length).toBeLessThanOrEqual(121);
    }
  });
  it("keeps a plain question as it is, and drops a sentence that is only code", () => {
    expect(plainAskedLine("Which colour should the badge be?")).toBe("Which colour should the badge be?");
    expect(plainAskedLine("Should I keep `GET /stats` as is? Or show zero for a deleted tally?")).toBe("Or show zero for a deleted tally?");
  });
});
