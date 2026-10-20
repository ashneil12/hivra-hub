import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { monoWorkStatus } from "./monoWorkStatus";

const tool = (kind: string): Block => ({
  id: kind,
  role: "tool",
  text: "Private activity details",
  tool: { kind, status: "in_progress" },
});

describe("Mono work status", () => {
  it.each([
    ["shell", "Running command…"],
    ["edit", "Editing file…"],
    ["search", "Exploring project…"],
    ["read", "Reading file…"],
    ["agent", "Running agent…"],
    ["other", "Using tool…"],
  ])("uses a short label for %s work", (kind, label) => {
    expect(monoWorkStatus([tool(kind)], true).label).toBe(label);
  });

  it("follows the latest narration and varies labels between messages, not chunks", () => {
    const first: Block = {
      id: "first",
      role: "assistant",
      text: "Private progress note",
      streaming: true,
    };
    const firstStatus = monoWorkStatus([tool("shell"), first], true);
    expect(firstStatus.label).toBe("Thinking…");
    expect(
      monoWorkStatus(
        [tool("shell"), { ...first, text: `${first.text} with another chunk` }],
        true,
      ),
    ).toEqual(firstStatus);
    expect(
      monoWorkStatus(
        [
          first,
          tool("shell"),
          { id: "second", role: "reasoning", text: "Private reasoning" },
        ],
        true,
      ).label,
    ).toBe("Pondering…");
  });

  it("reads a running workflow as lasting, and what the Lead does next once the run is over", () => {
    const run = (status: "running" | "completed"): Block => ({
      id: "wf",
      role: "tool",
      text: "Workflow",
      tool: { kind: "workflow", status: status === "running" ? "in_progress" : "completed" },
      workflowRun: {
        taskId: "w1",
        status,
        phases: [{ index: 1, title: "Verify" }],
        agents: [{ index: 1, label: "Verify findings", state: status === "running" ? "working" : "failed", phaseIndex: 1 }],
      },
    });
    expect(monoWorkStatus([run("running")], true)).toMatchObject({
      label: "Running workflow: Verify (0/1 agents)",
      lasting: "workflow:w1",
    });
    const after = monoWorkStatus([run("completed")], true);
    expect(after.label).toBe("Thinking…");
    expect(after.lasting).toBeUndefined();
  });

  it("prioritizes an unresolved approval over later narration", () => {
    expect(
      monoWorkStatus(
        [
          { ...tool("edit"), approval: { requestId: 1 } },
          { id: "note", role: "assistant", text: "Waiting" },
        ],
        true,
      ).label,
    ).toBe("Waiting for approval…");
  });

  it("keeps the finished summary and failed delegation visible", () => {
    expect(
      monoWorkStatus([tool("shell"), { ...tool("shell"), id: "second" }], false)
        .label,
    ).toBe("Ran 2 commands");
    const failed = {
      ...tool("agent"),
      tool: { kind: "agent", status: "failed" },
    };
    expect(monoWorkStatus([failed], false).label).toBe("Subagent failed");
  });
});
