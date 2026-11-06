import { describe, expect, it } from "vitest";
import { readPrCredit, readTaskCommits } from "./read";

const SECRET = "sk-ant-api03-SECRETVALUE";

describe("readTaskCommits", () => {
  it("turns a missing list into nothing", () => {
    expect(readTaskCommits(null)).toEqual([]);
    expect(readTaskCommits({})).toEqual([]);
  });

  it("drops a bad id, a duplicate, and a person's subject", () => {
    const rows = readTaskCommits([
      { sha: "abc1234", tier: "person", subject: SECRET, fileCount: 2, lineCount: 10 },
      { sha: "ABC1234", tier: "person", fileCount: 1, lineCount: 1 },
      { sha: "abc1234", tier: "confirmed", subject: "again" },
      { sha: "nope", tier: "confirmed" },
      null,
    ]);
    expect(rows).toEqual([
      {
        sha: "abc1234",
        tier: "person",
        agent: null,
        taskId: null,
        taskTitle: null,
        chatId: null,
        fileCount: 2,
        lineCount: 10,
        subject: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});

describe("readPrCredit", () => {
  it("lists each agent and task once, and a missing title falls back to the id", () => {
    expect(
      readPrCredit({
        agents: ["Ada", "Ada", "  "],
        tasks: [
          { id: "task-1", title: "Fix the gate" },
          { id: "task-1", title: "other" },
          { id: "task-2", title: "" },
        ],
      }),
    ).toEqual({
      agents: ["Ada"],
      tasks: [
        { id: "task-1", title: "Fix the gate" },
        { id: "task-2", title: "task-2" },
      ],
    });
    expect(readPrCredit(null)).toEqual({ agents: [], tasks: [] });
  });
});
