// WP-202: the First Mate's default delivery behaviour is written into its contract (prompt text only).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contract = readFileSync(new URL("./contract.md", import.meta.url), "utf8");

describe("the First Mate's default delivery behaviour (WP-202)", () => {
  it("keeps a pull request at the size its goal needs", () => {
    expect(contract).toContain("keep a pull request at the size its goal needs");
  });

  it("fixes real bugs in scope when a review bot suggests more, and declines the rest with one written reason", () => {
    expect(contract).toContain("when a review bot suggests more, fix the real bugs in scope");
    expect(contract).toContain("decline the rest with one written reason");
    expect(contract).toContain("list the declined ones as follow-ups");
  });
});
