import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskCommit } from "../read";
import { TaskCommits } from "./TaskCommits";

const SECRET = "sk-ant-api03-SECRETVALUE";

function commit(over: Partial<TaskCommit>): TaskCommit {
  return {
    sha: "abc1234",
    tier: "inferred",
    agent: "Ada",
    taskId: "task-1",
    taskTitle: "Fix the gate",
    chatId: "chat-1",
    fileCount: 1,
    lineCount: 2,
    subject: "Stamp the trailer",
    ...over,
  };
}

describe("TaskCommits", () => {
  it("shows an agent's subject and only the counts of a person's commit", () => {
    const html = renderToStaticMarkup(
      createElement(TaskCommits, {
        commits: [
          commit({}),
          commit({
            sha: "def5678",
            tier: "person",
            agent: null,
            taskId: null,
            taskTitle: null,
            chatId: null,
            fileCount: 2,
            lineCount: 10,
            subject: SECRET,
          }),
        ],
      }),
    );
    expect(html).toContain("Stamp the trailer");
    expect(html).toContain("2 files, 10 lines");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("the secret message");
  });
});
