import { describe, expect, it } from "vitest";
import {
  buildUsageHistory,
  costNote,
  dayKey,
  dayLabel,
  emptyTotals,
  formatTokenCount,
  formatUsd,
  toCsv,
  type UsageSession,
} from "./history";

/** Local wall-clock time, so a day boundary in the test is the reader's own day. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();

const NOW = at(2026, 11, 6, 15);

function session(
  id: string,
  cwd: string,
  harness: string,
  model: string,
  blocks: UsageSession["blocks"],
): UsageSession {
  return { id, cwd, harness, model, blocks };
}

function turn(
  id: string,
  startedAt: number,
  inputTokens?: number,
  extra: Partial<{
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    harness: string;
    name: string;
  }> = {},
) {
  const {
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    harness,
    name,
    ...rest
  } = extra;
  const metrics: Record<string, number> = {};
  if (inputTokens != null) metrics.inputTokens = inputTokens;
  for (const [key, value] of Object.entries({
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
  })) {
    if (value != null) metrics[key] = value;
  }
  void rest;
  return {
    id,
    role: "user" as const,
    startedAt,
    ...(Object.keys(metrics).length ? { turnMetrics: metrics } : {}),
    ...(harness || name
      ? { turnModel: { harness: harness ?? "", name: name ?? "" } }
      : {}),
  };
}

describe("buildUsageHistory", () => {
  it("sums a day's turns and fills every day in the window, oldest first", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/work/app", "claude", "sonnet-5", [
          turn("b1", at(2026, 11, 6, 9), 100, { outputTokens: 20, costUsd: 0.5 }),
          turn("b2", at(2026, 11, 6, 14), 50, { outputTokens: 10 }),
        ]),
      ],
      { now: NOW },
    );

    expect(history.days).toHaveLength(30);
    expect(history.days[29].day).toBe("2026-11-06");
    expect(history.days[28].day).toBe("2026-11-05");
    expect(history.days[0].day).toBe("2026-10-08");
    expect(history.days[29].totals).toEqual({
      turns: 2,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.5,
      costTurns: 1,
      unpricedTurns: 1,
      // WP-253: only the unpriced turn is estimated, at Sonnet 5's list price ($2 in, $10 out per million).
      estimatedUsd: expect.closeTo(0.0002, 10),
      estimatedTurns: 1,
      cacheSavedUsd: 0,
    });
    expect(history.days[0].totals).toEqual(emptyTotals());
    expect(history.today).toEqual(history.days[29].totals);
    expect(history.last7.turns).toBe(2);
    expect(history.last30.turns).toBe(2);
  });

  it("attributes a chat that runs past midnight to each turn's own day", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/work/app", "claude", "sonnet-5", [
          turn("late", at(2026, 11, 5, 23, 50), 1_000),
          turn("early", at(2026, 11, 6, 0, 10), 20),
        ]),
      ],
      { now: NOW },
    );

    const byDay = Object.fromEntries(history.days.map((day) => [day.day, day.totals]));
    expect(byDay["2026-11-05"].inputTokens).toBe(1_000);
    expect(byDay["2026-11-06"].inputTokens).toBe(20);
  });

  it("counts a turn by when it was sent when it has no start time", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/work/app", "claude", "sonnet-5", [
          {
            id: "b1",
            role: "user",
            sentAt: at(2026, 11, 4, 10),
            turnMetrics: { inputTokens: 7 },
          },
        ]),
      ],
      { now: NOW },
    );
    expect(history.days.find((day) => day.day === "2026-11-04")?.totals.turns).toBe(1);
  });

  it("skips a turn with no usable time and one with no metrics at all", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/work/app", "claude", "sonnet-5", [
          { id: "no-time", role: "user", turnMetrics: { inputTokens: 5 } },
          { id: "no-metrics", role: "user", startedAt: at(2026, 11, 6, 9) },
          turn("good", at(2026, 11, 6, 10), 3),
        ]),
      ],
      { now: NOW },
    );
    expect(history.last30).toEqual({
      turns: 1,
      inputTokens: 3,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      costTurns: 0,
      unpricedTurns: 1,
      estimatedUsd: expect.closeTo(0.000006, 12),
      estimatedTurns: 1,
      cacheSavedUsd: 0,
    });
  });

  it("keeps two engines, two models and two projects apart", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/work/app", "claude", "sonnet-5", [
          turn("b1", at(2026, 11, 6, 9), 100, { costUsd: 0.2, harness: "claude", name: "sonnet-5" }),
        ]),
        session("s2", "/work/lib", "codex", "gpt-5", [
          turn("b1", at(2026, 11, 6, 10), 300, { name: "gpt-5", harness: "codex" }),
        ]),
      ],
      { now: NOW },
    );

    expect(history.byEngine.map((group) => [group.key, group.label, group.totals.turns])).toEqual([
      ["codex", "Codex", 1],
      ["claude", "Claude Code", 1],
    ]);
    expect(history.byModel.map((group) => [group.label, group.totals.inputTokens])).toEqual([
      ["gpt-5", 300],
      ["sonnet-5", 100],
    ]);
    expect(history.byProject.map((group) => group.label)).toEqual(["lib", "app"]);
  });

  it("uses the turn's own engine and model, falling back to the chat's", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/work/app", "claude", "sonnet-5", [
          turn("b1", at(2026, 11, 6, 9), 10, { harness: "codex", name: "gpt-5" }),
          turn("b2", at(2026, 11, 6, 10), 10),
        ]),
      ],
      { now: NOW },
    );
    expect(history.byEngine.map((group) => group.key).sort()).toEqual(["claude", "codex"]);
    expect(history.byModel.map((group) => group.key).sort()).toEqual(["gpt-5", "sonnet-5"]);
  });

  it("shows a cost only when the engine reported one", () => {
    const reported = buildUsageHistory(
      [session("s1", "/w", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 10, { costUsd: 0.25 })])],
      { now: NOW },
    );
    expect(costNote(reported.last30)).toBe("Cost reported by the engine");
    expect(reported.byEngine[0].totals.costUsd).toBe(0.25);

    const silent = buildUsageHistory(
      [session("s1", "/w", "codex", "gpt-5", [turn("b1", at(2026, 11, 6, 9), 10)])],
      { now: NOW },
    );
    expect(costNote(silent.last30)).toBe("Cost not reported by this engine");
    expect(silent.byEngine[0].totals.costUsd).toBe(0);
    expect(silent.byEngine[0].totals.turns).toBe(1);
  });

  it("says how many turns reported a price when only some did", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/w", "claude", "sonnet-5", [
          turn("b1", at(2026, 11, 6, 9), 10, { costUsd: 0.1 }),
          turn("b2", at(2026, 11, 6, 10), 10),
        ]),
      ],
      { now: NOW },
    );
    expect(costNote(history.last30)).toBe("Cost reported for 1 of 2 turns");
  });

  it("never turns a token count into a price", () => {
    const history = buildUsageHistory(
      [session("s1", "/w", "codex", "gpt-5", [turn("b1", at(2026, 11, 6, 9), 1_000_000)])],
      { now: NOW },
    );
    expect(history.last30.costUsd).toBe(0);
    expect(history.last30.costTurns).toBe(0);
    expect(history.last30.unpricedTurns).toBe(1);
  });

  it("drops values it cannot use instead of counting them as zero", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/w", "claude", "sonnet-5", [
          {
            id: "odd",
            role: "user",
            startedAt: at(2026, 11, 6, 9),
            turnMetrics: {
              inputTokens: -5,
              outputTokens: Number.NaN,
              cacheReadTokens: Number.POSITIVE_INFINITY,
              costUsd: -1,
            },
          },
          {
            id: "text",
            role: "user",
            startedAt: at(2026, 11, 6, 10),
            turnMetrics: { inputTokens: "12" as unknown as number },
          },
        ]),
      ],
      { now: NOW },
    );
    expect(history.last30).toEqual(emptyTotals());
    expect(history.days).toHaveLength(30);
  });

  it("keeps a very large count finite and never past the safe integer range", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/w", "claude", "sonnet-5", [
          turn("a", at(2026, 11, 6, 9), Number.MAX_SAFE_INTEGER),
          turn("b", at(2026, 11, 6, 10), Number.MAX_SAFE_INTEGER),
          turn("c", at(2026, 11, 6, 11), Number.MAX_VALUE),
        ]),
      ],
      { now: NOW },
    );
    expect(Number.isFinite(history.last30.inputTokens)).toBe(true);
    expect(history.last30.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(history.last30.costUsd)).toBe(true);
  });

  it("counts the window's first day and drops anything older", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/w", "claude", "sonnet-5", [
          turn("edge", at(2026, 10, 8, 0, 0), 1),
          turn("older", at(2026, 10, 7, 23, 59), 1),
        ]),
      ],
      { now: NOW },
    );
    expect(history.last30.turns).toBe(1);
    expect(history.days[0].totals.turns).toBe(1);
  });

  it("counts a turn late on the last day, including a day that lasts 25 hours", () => {
    const late = at(2026, 11, 1, 23, 30);
    const history = buildUsageHistory(
      [session("s1", "/w", "claude", "sonnet-5", [turn("late", late, 7)])],
      { now: late },
    );
    expect(history.today.turns).toBe(1);
    expect(history.days.at(-1)?.totals.inputTokens).toBe(7);
  });

  it("puts a turn stamped in the future into today, never a day past the window", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/w", "claude", "sonnet-5", [
          turn("skewed", at(2026, 11, 9, 9), 5),
        ]),
      ],
      { now: NOW },
    );
    expect(history.last30.turns).toBe(1);
    expect(history.days[29].totals.turns).toBe(1);
    expect(history.days).toHaveLength(30);
  });

  it("counts a turn once when the same chat is offered twice", () => {
    const one = session("s1", "/w", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 10)]);
    const history = buildUsageHistory([one, one], { now: NOW });
    expect(history.last30.turns).toBe(1);
    expect(history.last30.inputTokens).toBe(10);
  });

  it("names two projects with the same folder name apart", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/work/a/app", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 10)]),
        session("s2", "/work/b/app", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 20)]),
      ],
      { now: NOW },
    );
    expect(history.byProject.map((group) => group.label).sort()).toEqual(["a/app", "b/app"]);
  });

  it("uses Windows paths and a chat with no project", () => {
    const history = buildUsageHistory(
      [
        session("s1", "C:\\Work\\App", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 10)]),
        session("s2", "", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 20)]),
      ],
      { now: NOW },
    );
    expect(history.byProject.map((group) => group.label).sort()).toEqual(["App", "No project"]);
  });

  it("orders projects, engines and models by what they used, then by name", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/w/a", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 10)]),
        session("s2", "/w/b", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 20)]),
        session("s3", "/w/c", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 20)]),
      ],
      { now: NOW },
    );
    expect(history.byProject.map((group) => [group.label, group.totals.inputTokens])).toEqual([
      ["b", 20],
      ["c", 20],
      ["a", 10],
    ]);
  });

  it("keeps counts and names only, never a prompt or a reply", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/w/secret-project", "claude", "sonnet-5", [
          {
            id: "b1",
            role: "user",
            startedAt: at(2026, 11, 6, 9),
            text: "my bank password is hunter2",
            turnMetrics: { inputTokens: 10 },
          },
          {
            id: "b2",
            role: "assistant",
            text: "the reply that must not travel",
            turnMetrics: { inputTokens: 5 },
          },
        ]),
      ],
      { now: NOW },
    );
    const everything = JSON.stringify(history) + toCsv(history);
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain("must not travel");
    // The project's name is kept; its full path is not.
    expect(everything).not.toContain("/w/secret-project");
    expect(everything).not.toContain("/w/");
    expect(history.byProject[0].label).toBe("secret-project");
  });

  it("does not mutate what it was given", () => {
    const blocks = [turn("b1", at(2026, 11, 6, 9), 10)];
    const one = session("s1", "/w", "claude", "sonnet-5", blocks);
    const before = JSON.stringify(one);
    buildUsageHistory([one], { now: NOW });
    expect(JSON.stringify(one)).toBe(before);
  });

  it("returns an empty window for a clock value it cannot read", () => {
    const history = buildUsageHistory(
      [session("s1", "/w", "claude", "sonnet-5", [turn("b1", at(2026, 11, 6, 9), 10)])],
      { now: Number.NaN },
    );
    expect(history.last30).toEqual(emptyTotals());
    expect(history.days).toHaveLength(30);
  });

  it("honours a shorter window when asked for one", () => {
    const history = buildUsageHistory(
      [session("s1", "/w", "claude", "sonnet-5", [turn("b1", at(2026, 11, 4, 9), 10)])],
      { now: NOW, days: 2 },
    );
    expect(history.days.map((day) => day.day)).toEqual(["2026-11-05", "2026-11-06"]);
    expect(history.last30.turns).toBe(0);
  });
});

describe("labels", () => {
  it("keeps a day key in local time", () => {
    expect(dayKey(at(2026, 11, 6, 0, 0))).toBe("2026-11-06");
    expect(dayKey(at(2026, 11, 6, 23, 59))).toBe("2026-11-06");
  });

  it("writes a day in plain words", () => {
    expect(dayLabel("2026-11-06")).toBe("6 Nov");
    expect(dayLabel("nonsense")).toBe("");
  });

  it("writes a token count with grouping, and nothing for a value it cannot read", () => {
    expect(formatTokenCount(1_234_567)).toBe((1_234_567).toLocaleString(undefined, { maximumFractionDigits: 0 }));
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(-5)).toBe("0");
  });

  it("writes a price with enough digits to be true", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.125)).toBe("$0.125");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

describe("toCsv", () => {
  it("writes one header and a row per summary, day, project, engine and model", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/w/app", "claude", "sonnet-5", [
          turn("b1", at(2026, 11, 6, 9), 10, { costUsd: 0.25 }),
        ]),
      ],
      { now: NOW },
    );
    const lines = toCsv(history).trim().split("\n");
    expect(lines[0]).toBe(
      "Group,Name,Day,Turns,Input tokens,Output tokens,Cache read tokens,Cache write tokens,Cost (USD),Turns with a cost,Turns without a cost",
    );
    expect(lines).toHaveLength(1 + 3 + 30 + 1 + 1 + 1);
    expect(lines[1]).toBe("Summary,Today,,1,10,0,0,0,0.2500,1,0");
    expect(lines[3]).toBe("Summary,Last 30 days,,1,10,0,0,0,0.2500,1,0");
    expect(lines.some((line) => line === "Project,app,,1,10,0,0,0,0.2500,1,0")).toBe(true);
    expect(lines.some((line) => line === "Engine,Claude Code,,1,10,0,0,0,0.2500,1,0")).toBe(true);
    expect(lines.some((line) => line === "Model,sonnet-5,,1,10,0,0,0,0.2500,1,0")).toBe(true);
  });

  it("quotes a name that holds a comma or a quote", () => {
    const history = buildUsageHistory(
      [
        session('s1', '/w/a,b "c"', "claude", 'model, "x"', [
          turn("b1", at(2026, 11, 6, 9), 1),
        ]),
      ],
      { now: NOW },
    );
    const csv = toCsv(history);
    expect(csv).toContain('"a,b ""c"""');
    expect(csv).toContain('"model, ""x"""');
  });
});

describe("WP-253: list-price estimates", () => {
  it("estimates only turns with no reported price, and counts cache savings for every listed model", () => {
    const history = buildUsageHistory(
      [
        session("s1", "/work/app", "codex", "gpt-5.4", [turn("x", at(2026, 11, 6, 9), 1_000_000)]),
        session("s2", "/work/app", "claude", "claude-opus-5-5[1m]", [
          turn("p", at(2026, 11, 6, 10), 1_000_000, { costUsd: 9, cacheReadTokens: 1_000_000 }),
          turn("u", at(2026, 11, 6, 11), 1_000_000, { outputTokens: 1_000_000 }),
        ]),
      ],
      { now: NOW },
    );
    const t = history.today;
    // gpt-5.4 has no listed price: counted as unpriced, never guessed.
    expect(t.unpricedTurns).toBe(2);
    expect(t.estimatedTurns).toBe(1);
    // Opus 5.5: $4 in + $20 out for the unpriced turn. The priced turn keeps its reported $9 and is not re-priced.
    expect(t.estimatedUsd).toBeCloseTo(24, 6);
    expect(t.costUsd).toBe(9);
    // A million cache reads at $0.20 instead of $4 input saved $3.80.
    expect(t.cacheSavedUsd).toBeCloseTo(3.8, 6);
    const codex = history.byEngine.find((group) => group.key === "codex")!;
    expect(codex.totals.estimatedTurns).toBe(0);
  });
});

