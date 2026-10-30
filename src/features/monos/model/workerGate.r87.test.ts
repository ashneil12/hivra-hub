import { describe, expect, it } from "vitest";
import { signOffFrom, SIGN_OFF_REACH_MS } from "./workerGate";

const row = (createdAt: number, ownerSession = "lead", project: string | null = "tally") => ({ ownerSession, project, createdAt });

describe("signOffFrom (s14 r87 #1)", () => {
  it("counts Ash's answer to the first job for the Lead's follow-up job on the same project", () => {
    // First job 07:47, Ash answered 07:50, second job started 07:51: the answer must count for the second.
    const first = 1_000_000;
    const second = first + 4 * 60_000;
    expect(signOffFrom(second, "lead", "tally", [row(first), row(second)])).toBe(first);
  });
  it("ignores other Leads, other projects and jobs out of reach", () => {
    const now = 10 * SIGN_OFF_REACH_MS;
    const rows = [row(now - 1000, "other"), row(now - 1000, "lead", "else"), row(now - SIGN_OFF_REACH_MS - 1), row(now)];
    expect(signOffFrom(now, "lead", "tally", rows)).toBe(now);
  });
  it("keeps the worker's own start with no project", () => {
    expect(signOffFrom(5, "lead", null, [row(1)])).toBe(5);
  });
});
