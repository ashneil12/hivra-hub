// The delegate tool's calls in a Lead's chat (H4): named with T3's verb/past-tense table, a group summed up by distinct
// task, and an error returned as data read as a failure (T3's t3McpToolPresentation / t3ToolSummary, MIT).
import { describe, expect, it } from "vitest";
import { monoSpawnedSessions } from "../../monos/model/monoSpawnedSessions";
import {
  delegateToolLabel,
  delegateToolName,
  delegateToolsSummary,
  monoCodeToolCall,
  monoCodeWorkSummary,
} from "./monocodeToolCall";
import type { Block } from "./session";

function call(tool: string, status: string, detail?: unknown): Block {
  return {
    id: `${tool}-${Math.random()}`,
    role: "tool",
    text: `mcp__monocode__${tool}`,
    tool: {
      kind: `mcp__monocode__${tool}`,
      title: `mcp__monocode__${tool}`,
      status,
      ...(detail !== undefined
        ? {
            detail:
              typeof detail === "string" ? detail : JSON.stringify(detail),
          }
        : {}),
    },
  };
}

describe("the delegate tool's calls", () => {
  it("are recognized by their MCP name only", () => {
    expect(delegateToolName(call("delegate_task", "completed"))).toBe(
      "delegate_task",
    );
    expect(delegateToolName(call("task_answer", "pending"))).toBe(
      "task_answer",
    );
    expect(delegateToolName(call("task_accept", "completed"))).toBe("task_accept");
    expect(delegateToolLabel(call("task_accept", "completed"), "task_accept")).toBe(
      "Accepted a finished task",
    );
    expect(
      delegateToolName({ ...call("other_tool", "completed") }),
    ).toBeUndefined();
    expect(
      delegateToolName({
        id: "x",
        role: "assistant",
        text: "mcp__monocode__delegate_task",
      }),
    ).toBeUndefined();
    expect(monoCodeToolCall(call("task_cancel", "completed"))).toMatchObject({
      action: "task_cancel",
      delegate: "task_cancel",
      label: "Stop a task",
    });
  });

  it("read in the present while they run and the past once done", () => {
    expect(
      delegateToolLabel(call("delegate_task", "in_progress"), "delegate_task"),
    ).toBe("Delegating a task");
    expect(
      delegateToolLabel(call("delegate_task", "completed"), "delegate_task"),
    ).toBe("Delegated a task");
    expect(delegateToolLabel(call("task_wait", "completed"), "task_wait")).toBe(
      "Waited for tasks",
    );
    expect(
      delegateToolLabel(call("task_answer", "completed"), "task_answer"),
    ).toBe("Answered a worker's question");
    expect(
      delegateToolLabel(call("task_status", "pending"), "task_status"),
    ).toBe("Checking task status");
  });

  it("count an error returned as data as a failure", () => {
    const refused = call("task_answer", "completed", {
      isError: true,
      content: [{ type: "text", text: "no" }],
    });
    expect(delegateToolLabel(refused, "task_answer")).toBe(
      "Tried to answer a worker's question",
    );
    expect(
      delegateToolLabel(
        call("task_cancel", "failed", "No task t-9 of yours"),
        "task_cancel",
      ),
    ).toBe("Tried to stop a task");
  });

  it("sum a group up by distinct task, the way T3 does", () => {
    const delegated = [
      call("delegate_task", "completed", {
        taskId: "t-1",
        childSessionId: "app-lead-r1",
      }),
      call("delegate_task", "completed", {
        taskId: "t-2",
        childSessionId: "app-lead-r2",
      }),
      // A retried call with the same clientRequestId returns the same task: counted once.
      call("delegate_task", "completed", {
        taskId: "t-2",
        childSessionId: "app-lead-r2",
      }),
    ];
    expect(delegateToolsSummary(delegated, false)).toBe("Delegated 2 tasks");
    expect(monoCodeWorkSummary(delegated, false)).toBe("Delegated 2 tasks");
    expect(
      delegateToolsSummary(
        [call("task_status", "completed"), call("task_status", "completed")],
        false,
      ),
    ).toBe("Checked task status 2 times");
    expect(
      delegateToolsSummary([call("delegate_task", "failed", "refused")], false),
    ).toBe("Tried to delegate 1 task");
    // Mixed tools are just MonoCode work.
    expect(
      monoCodeWorkSummary(
        [call("task_status", "completed"), ...delegated],
        true,
      ),
    ).toBe("Using MonoCode");
  });

  it("anchor a delegated worker's card on the call that started it", () => {
    const launch = {
      sessionId: "app-lead-r1",
      cwd: "/code/vg-game",
      title: "Fix the save bug",
      harness: "claude" as const,
      model: "claude:sonnet-5",
    };
    const block = call("delegate_task", "completed", {
      taskId: "t-1",
      childSessionId: "app-lead-r1",
      status: "running",
    });
    expect(monoSpawnedSessions([block], [launch])).toEqual([launch]);
    expect(
      monoSpawnedSessions(
        [call("task_status", "completed", { tasks: [] })],
        [launch],
      ),
    ).toEqual([]);
  });
});
