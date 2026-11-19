// WP-171: delegate_tasks, the multi-part form of delegate_task, reads in the chat the way delegate_task does: named in
// plain words, the cards of every worker it started anchored on it, the live line "Handing out a job", and no nudge
// to start workers or fix a mismatch after a turn that handed the work out with it.
import { describe, expect, it } from "vitest";
import { mismatchFixNudge } from "../../monos/model/mismatchFixNudge";
import { monoSpawnedSessions } from "../../monos/model/monoSpawnedSessions";
import { workerStartNudge } from "../../monos/model/workerStartNudge";
import { HANDING_OUT, plainToolStep } from "./liveActivity";
import { delegateToolLabel, delegateToolName, delegateToolsSummary, monoCodeToolCall } from "./monocodeToolCall";
import { newSession, type Block, type Session } from "./session";

function call(tool: string, status: string, detail?: unknown): Block {
  return {
    id: `${tool}-${status}`,
    role: "tool",
    text: `mcp__monocode__${tool}`,
    tool: {
      kind: `mcp__monocode__${tool}`,
      title: `mcp__monocode__${tool}`,
      status,
      ...(detail !== undefined ? { detail: typeof detail === "string" ? detail : JSON.stringify(detail) } : {}),
    },
  };
}

const RESULT = {
  waves: [["api", "docs"], ["board"]],
  tasks: [
    { name: "api", wave: 1, taskId: "t-1", childSessionId: "app-lead-r1-api", status: "running" },
    { name: "board", wave: 2, childSessionId: "app-lead-r1-board", status: "waiting" },
    { name: "docs", wave: 1, taskId: "t-2", childSessionId: "app-lead-r1-docs", status: "running" },
  ],
  note: "2 started now; 1 waits for what it needs.",
};
const launch = (sessionId: string) => ({
  sessionId,
  cwd: "/code/tally",
  title: sessionId,
  harness: "claude" as const,
  model: "claude:sonnet-5",
});

describe("delegate_tasks in the chat (WP-171)", () => {
  it("is one of the delegate tool's calls, named in plain words", () => {
    expect(delegateToolName(call("delegate_tasks", "completed", RESULT))).toBe("delegate_tasks");
    expect(delegateToolName({ ...call("delegate_tasks", "completed"), text: "monocode:delegate_tasks", tool: { kind: "monocode:delegate_tasks", status: "completed" } })).toBe("delegate_tasks");
    expect(monoCodeToolCall(call("delegate_tasks", "in_progress"))).toMatchObject({ delegate: "delegate_tasks" });
    expect(delegateToolLabel(call("delegate_tasks", "in_progress"), "delegate_tasks")).toBe("Delegating a multi-part ask");
    expect(delegateToolLabel(call("delegate_tasks", "completed", RESULT), "delegate_tasks")).toBe("Handed out 3 tasks");
    expect(delegateToolLabel(call("delegate_tasks", "completed", "Not sent: nothing provides /api/score"), "delegate_tasks")).toBe(
      "Delegated a multi-part ask",
    );
    expect(
      delegateToolLabel(call("delegate_tasks", "completed", { isError: true, content: [{ type: "text", text: "no" }] }), "delegate_tasks"),
    ).toBe("Tried to delegate a multi-part ask");
    expect(delegateToolsSummary([call("delegate_tasks", "completed", RESULT)], false)).toBe("Delegated 3 tasks");
  });

  it("anchors the card of every worker it handed out on the call", () => {
    const known = ["app-lead-r1-api", "app-lead-r1-board", "app-lead-r1-docs", "app-lead-other"].map(launch);
    expect(monoSpawnedSessions([call("delegate_tasks", "completed", RESULT)], known).map((entry) => entry.sessionId)).toEqual([
      "app-lead-r1-api",
      "app-lead-r1-board",
      "app-lead-r1-docs",
    ]);
    expect(monoSpawnedSessions([call("delegate_tasks", "failed", RESULT)], known)).toEqual([]);
  });

  it("reads as handing out a job while it runs", () => {
    expect(plainToolStep(call("delegate_tasks", "in_progress"))).toBe(HANDING_OUT);
  });

  it("counts as starting workers, so no nudge to start them or to fix a mismatch follows", () => {
    const ash: Block = { id: "u1", role: "user", text: "1. the score api 2. the board 3. the readme", startedAt: 1_000 };
    const said: Block = { id: "a1", role: "assistant", text: "Starting now on all three: the api, the board and the readme." };
    const chat = (blocks: Block[]): Session => ({ ...newSession("claude", "/p"), id: "lead", blocks });
    const handed = call("delegate_tasks", "completed", RESULT);
    expect(workerStartNudge(chat([ash, said]), [], new Set())?.id).toBe("start-workers-u1");
    expect(workerStartNudge(chat([ash, handed, said]), [], new Set())).toBeUndefined();
    const report: Block = { id: "u2", role: "user", text: "[MonoCode] reports are in. Roll it all up", internal: true };
    const rollUp: Block = {
      id: "a2",
      role: "assistant",
      text: "Not fixed: the README still describes the score as a string, which is not what the route returns.",
    };
    expect(mismatchFixNudge(chat([report, rollUp]), new Set())?.id).toBe("fix-mismatch-a2");
    expect(mismatchFixNudge(chat([report, handed, rollUp]), new Set())).toBeUndefined();
  });
});
