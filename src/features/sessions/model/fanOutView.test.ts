import { describe, expect, it } from "vitest";
import { assignFanOutWorktrees, planFanOut, replaceFanOutChildren } from "./fanOut";
import { fanOutChildSpend, fanOutCompareRows, fanOutNotStartedLines } from "./fanOutView";

function record(over: { notStarted?: { provider: "claude" | "codex"; model: string }[] } = {}) {
  const planned = planFanOut({
    prompt: "Fix the flaky test",
    targets: [
      { provider: "claude", model: "one" },
      { provider: "codex", model: "two" },
    ],
    ids: (() => {
      const left = ["compare-1", "child-a", "child-b"];
      return { next: () => left.shift() ?? "extra" };
    })(),
    now: 10,
  });
  if (!planned.ok) throw new Error(planned.code);
  const children = assignFanOutWorktrees(planned.record.children, {
    projectRoot: "/work/proj",
    allowedRoots: ["/work/trees"],
    git: true,
    offers: [
      { path: "/work/trees/a", branch: "mc/fan-a" },
      { path: "/work/trees/b", branch: "mc/fan-b" },
    ],
  });
  const written = replaceFanOutChildren(planned.record, planned.record.revision, children);
  if (!written.ok) throw new Error(written.code);
  return { ...written.record, ...over };
}

describe("fanOutChildSpend", () => {
  it("adds up the prices the engine reported, and does not guess the rest", () => {
    expect(
      fanOutChildSpend([
        { role: "user", turnMetrics: { costUsd: 0.0123 } },
        { role: "assistant", text: "done" },
        { role: "user", turnMetrics: { costUsd: 0.02 } },
      ]),
    ).toBe("Spent $0.032");
  });

  it("says a turn had tokens but no price instead of showing $0.00", () => {
    expect(fanOutChildSpend([{ role: "user", turnMetrics: { inputTokens: 900, outputTokens: 40 } }])).toBe(
      "Spent: no price reported",
    );
    expect(
      fanOutChildSpend([
        { role: "user", turnMetrics: { costUsd: 1.5 } },
        { role: "user", turnMetrics: { inputTokens: 10 } },
      ]),
    ).toBe("Spent $1.50 (1 turn had no price)");
  });

  it("says nothing was reported yet when no turn has finished", () => {
    expect(fanOutChildSpend(undefined)).toBe("Spent: nothing reported yet");
    expect(fanOutChildSpend([{ role: "user", text: "Fix it" }])).toBe("Spent: nothing reported yet");
  });

  it("ignores a price that is not a usable number", () => {
    expect(
      fanOutChildSpend([
        { role: "user", turnMetrics: { costUsd: Number.NaN } },
        { role: "user", turnMetrics: { costUsd: -3 } },
        { role: "user", turnMetrics: { costUsd: 0.5 } },
      ]),
    ).toBe("Spent $0.50");
  });
});

describe("compare rows", () => {
  it("shows each child's own spend", () => {
    const rows = fanOutCompareRows(record(), [
      { id: "child-a", blocks: [{ role: "user", turnMetrics: { costUsd: 0.25 } }] },
      { id: "child-b", blocks: [{ role: "user", turnMetrics: { costUsd: 0.5 } }] },
    ]);
    expect(rows.map((row) => row.spend)).toEqual(["Spent $0.25", "Spent $0.50"]);
  });

  it("lets a discard that has not finished be tried again, and nothing else", () => {
    const current = record();
    const rows = fanOutCompareRows(
      { ...current, discardedIds: ["child-a", "child-b"], cleanup: { "child-b": "removed" } },
      [],
    );
    expect(rows.map((row) => row.canDiscard)).toEqual([true, false]);
    const fresh = fanOutCompareRows(current, []);
    expect(fresh.map((row) => row.canDiscard)).toEqual([true, true]);
    const won = fanOutCompareRows({ ...current, winnerId: "child-a" }, []);
    expect(won.map((row) => row.canDiscard)).toEqual([false, true]);
  });
});

describe("fanOutNotStartedLines", () => {
  it("names each model that did not start and why, without dash characters", () => {
    const lines = fanOutNotStartedLines(
      record({
        notStarted: [
          { provider: "codex", model: "gpt-x" },
          { provider: "claude", model: "opus" },
        ],
      }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("gpt-x");
    expect(lines[0]).toMatch(/did not start/);
    expect(lines[0]).toMatch(/own worktree/);
    expect(lines.join(" ")).not.toMatch(/[—–]/);
    expect(fanOutNotStartedLines(record())).toEqual([]);
  });
});
