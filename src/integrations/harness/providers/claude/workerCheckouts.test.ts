import { describe, expect, it } from "vitest";
import { workerCheckoutsArgs, workerCheckoutsRule } from "./workerCheckouts";

describe("a Lead reads its workers' checkouts without asking Ash (r82, c02)", () => {
  it("allows reads in the project's sibling -worktrees folder", () => {
    expect(workerCheckoutsRule("/Users/ash/Projects/tally")).toBe("Read(//Users/ash/Projects/tally-worktrees/**)");
    expect(workerCheckoutsRule("/Users/ash/Projects/tally/")).toBe("Read(//Users/ash/Projects/tally-worktrees/**)");
  });

  it("adds nothing for a worker inside that folder, the folder itself, or no folder", () => {
    expect(workerCheckoutsRule("/Users/ash/Projects/tally-worktrees/mc-1a2b")).toBeUndefined();
    expect(workerCheckoutsRule("/Users/ash/Projects/tally-worktrees")).toBeUndefined();
    expect(workerCheckoutsRule(undefined)).toBeUndefined();
    expect(workerCheckoutsRule("relative/tally")).toBeUndefined();
  });

  it("only reads, as a flag every Claude chat process gets (the dev copy drops settings rules)", () => {
    expect(workerCheckoutsArgs("/Users/ash/Projects/tally")).toEqual(["--allowedTools", "Read(//Users/ash/Projects/tally-worktrees/**)"]);
    expect(workerCheckoutsArgs("/Users/ash/Projects/tally-worktrees/mc-1")).toEqual([]);
  });
});
