import { describe, expect, it } from "vitest";
import { buildUsageHistory, toCsv } from "./history";
import { readUsageSessions } from "./read";

/**
 * WP-108: the history holds counts and project names only. A prompt, a reply, or a full path never gets in.
 */

const at = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour).getTime();

const NOW = at(2026, 11, 6, 15);

describe("usage privacy", () => {
  it("keeps counts and project names, and drops prompt and reply text", () => {
    const sessions = readUsageSessions([
      {
        id: "s1",
        cwd: "/work/secret-project",
        harness: "claude",
        model: "sonnet-5",
        title: "my bank password is hunter2",
        blocks: [
          {
            id: "b1",
            role: "user",
            text: "my bank password is hunter2",
            startedAt: at(2026, 11, 6, 9),
            turnModel: {
              harness: "claude",
              name: "sonnet-5",
              note: "the reply that must not travel",
            },
            turnMetrics: {
              inputTokens: 10,
              outputTokens: "must not travel",
              costUsd: 0.2,
              hidden: "must not travel",
            },
            toolUses: [{ output: "ls output that must not travel" }],
          },
          {
            id: "b2",
            role: "assistant",
            text: "the reply that must not travel",
            turnMetrics: { inputTokens: 5 },
          },
        ],
      },
      "not a chat",
      { id: "", cwd: "/work/nope", blocks: [] },
    ]);

    const history = buildUsageHistory(sessions, { now: NOW });
    const read = JSON.stringify(sessions);
    const published = JSON.stringify(history) + toCsv(history);

    // The read keeps a path only so the history can name the project. It never keeps the words.
    expect(read).not.toContain("hunter2");
    expect(read).not.toContain("must not travel");
    // What the page and the CSV hold: counts and the project name. Not the path, not the words.
    expect(published).not.toContain("hunter2");
    expect(published).not.toContain("must not travel");
    expect(published).not.toContain("/work/secret-project");
    expect(published).not.toContain("/work/");
    expect(history.byProject.map((group) => group.label)).toEqual(["secret-project"]);
    expect(history.last30.inputTokens).toBe(10);
    expect(history.last30.outputTokens).toBe(0);
    expect(history.last30.costUsd).toBe(0.2);
    expect(history.byEngine.map((group) => group.label)).toEqual(["Claude Code"]);
  });

  it("treats a reply that is not a list as a failed read, not as no usage", () => {
    expect(() => readUsageSessions({ blocks: [] })).toThrow(/not a list/);
    expect(() => readUsageSessions(null)).toThrow(/not a list/);
    expect(readUsageSessions([])).toEqual([]);
  });
});
