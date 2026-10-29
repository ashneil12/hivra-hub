import { describe, expect, it } from "vitest";
import { withDevCopiesOff } from "./devCopies";
import { withWorkerCheckoutsReadable, workerCheckoutsRule } from "./workerCheckouts";

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

  it("only reads: no edit rule, and the dev-copy deny rules stay", () => {
    const settings = withWorkerCheckoutsReadable(withDevCopiesOff({}, "/Users/ash/Projects/tally"), "/Users/ash/Projects/tally");
    expect(settings.permissions?.allow).toEqual(["Read(//Users/ash/Projects/tally-worktrees/**)"]);
    expect(settings.permissions?.allow?.some((r) => /^(Edit|Write|Bash)/.test(r))).toBe(false);
    expect(settings.permissions?.deny?.length).toBeGreaterThan(0);
  });
});
