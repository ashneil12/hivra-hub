import { describe, expect, it, vi } from "vitest";
import { retryRequestId, retrySameBrief } from "./retry";

const row = {
  id: "row-1",
  brief: "Fix the save bug in the project.",
  goal: "The save test passes.",
  title: "Save bug",
};

describe("retry the same brief", () => {
  it("re-delegates that brief and keeps the attempt on the old row", async () => {
    const run = vi.fn(async () => undefined);
    await retrySameBrief(row, run, "nonce1");
    expect(run).toHaveBeenCalledOnce();
    const [requestId, input] = run.mock.calls[0]!;
    expect(input.redoes).toBe(row.id);
    expect(input.brief).toBe(row.brief);
    expect(input.goal).toBe(row.goal);
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
  });

  it("does not send when the brief is blank", async () => {
    const run = vi.fn(async () => undefined);
    await expect(retrySameBrief({ id: "row-1", brief: "  " }, run)).rejects.toThrow(/brief/);
    expect(run).not.toHaveBeenCalled();
  });

  it("uses a fresh request id, and rejects a nonce that is only punctuation", () => {
    const first = retryRequestId("row 1");
    const second = retryRequestId("row 1");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    expect(() => retryRequestId("row-1", "!!!")).toThrow(/nonce/);
  });
});
