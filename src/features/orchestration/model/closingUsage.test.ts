import { describe, expect, it } from "vitest";
import { normalizeOrchestrationRun, type OrchestrationRun } from "./orchestrationState";
import {
  closingUsageLine,
  normalizeClosingUsage,
  sumChildUsage,
  usageFromSession,
} from "./closingUsage";

const block = (id: string, metrics: unknown) => ({
  id,
  role: "user",
  text: "do the work",
  turnMetrics: metrics,
});

describe("sumChildUsage", () => {
  it("adds what each child recorded and leaves a missing child out", () => {
    const total = sumChildUsage([
      { sessionId: "a", usage: { inputTokens: 10, outputTokens: 4 } },
      { sessionId: "b", usage: undefined },
      { sessionId: "c", usage: { outputTokens: 6, costUsd: 0.02 } },
    ]);
    expect(total).toEqual({ inputTokens: 10, outputTokens: 10, costUsd: 0.02 });
    expect(total).not.toHaveProperty("cacheReadTokens");
  });

  it("is absent when nobody recorded a count, including zeros and junk", () => {
    expect(sumChildUsage([])).toBeUndefined();
    expect(
      sumChildUsage([
        { sessionId: "a", usage: undefined },
        { sessionId: "b", usage: { outputTokens: 0, inputTokens: -3, cacheReadTokens: Number.NaN } },
        { sessionId: "c", usage: "12" },
        { sessionId: "", usage: { outputTokens: 9 } },
      ]),
    ).toBeUndefined();
    expect(closingUsageLine(undefined)).toBeUndefined();
    expect(closingUsageLine({ outputTokens: 0 })).toBeUndefined();
  });

  it("counts one session once when two tasks name it, and a later real record wins", () => {
    const total = sumChildUsage([
      { sessionId: "same", usage: { outputTokens: 5 } },
      { sessionId: "same", usage: { outputTokens: 8, inputTokens: 2 } },
      { sessionId: "same", usage: { outputTokens: -1 } },
    ]);
    expect(total).toEqual({ outputTokens: 8, inputTokens: 2 });
  });

  it("stops at the safe integer instead of turning a broken count into Infinity", () => {
    const total = sumChildUsage([
      { sessionId: "a", usage: { outputTokens: Number.MAX_SAFE_INTEGER } },
      { sessionId: "b", usage: { outputTokens: Number.MAX_SAFE_INTEGER } },
    ]);
    expect(total).toEqual({ outputTokens: Number.MAX_SAFE_INTEGER });
  });

  it("reads a child's turns, skips a repeated block, and ignores a turn with no metrics", () => {
    const usage = usageFromSession({
      blocks: [
        block("t1", { outputTokens: 3 }),
        block("t1", { outputTokens: 7 }),
        { id: "t2", role: "user", text: "again" },
        { id: "t3", role: "assistant", text: "no", turnMetrics: { outputTokens: 100 } },
        block("t4", { inputTokens: 1.5, cacheWriteTokens: 4 }),
      ],
    });
    expect(usage).toEqual({ outputTokens: 7, inputTokens: 1.5, cacheWriteTokens: 4 });
    expect(usageFromSession(undefined)).toBeUndefined();
    expect(usageFromSession({ blocks: "nope" })).toBeUndefined();
  });

  it("says the figures in one sentence and drops a field nobody recorded", () => {
    expect(closingUsageLine({ inputTokens: 12, outputTokens: 340, costUsd: 0.02 })).toBe(
      "Children used 12 in, 340 out, $0.02.",
    );
    expect(closingUsageLine({ outputTokens: 340 })).toBe("Children used 340 out.");
    expect(normalizeClosingUsage({ outputTokens: 4, note: "secret" })).toEqual({
      outputTokens: 4,
    });
  });
});

describe("a saved run", () => {
  const run = (status: OrchestrationRun["status"], closingUsage: unknown): OrchestrationRun =>
    ({
      version: 2,
      leadId: "lead",
      cwd: "/repo",
      status,
      allowedHarnesses: ["claude"],
      maxWorkers: 1,
      cli: "claude",
      tasks: [],
      continuations: 0,
      requests: {},
      closingUsage,
    }) as OrchestrationRun;

  it("keeps closing usage only on a finished run, and only the counts", () => {
    expect(normalizeOrchestrationRun(run("finished", { outputTokens: 9, inputTokens: 0 })).closingUsage).toEqual({
      outputTokens: 9,
    });
    expect(normalizeOrchestrationRun(run("active", { outputTokens: 9 })).closingUsage).toBeUndefined();
    expect(normalizeOrchestrationRun(run("finished", { outputTokens: "9" })).closingUsage).toBeUndefined();
    expect(normalizeOrchestrationRun(run("stopped", { outputTokens: 9 })).closingUsage).toBeUndefined();
  });
});
