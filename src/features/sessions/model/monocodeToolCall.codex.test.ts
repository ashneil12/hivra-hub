// WP-120: a Codex lead names its MCP calls "monocode:<tool>" (the mcpToolCall item, codexProtocol.ts), where Claude Code
// says "mcp__monocode__<tool>". Rows built the way a real Codex turn builds them must read as the delegate tool's:
// the card, the worker link and the activity labels show, and the app does not nudge a lead that already delegated.
import { describe, expect, it } from "vitest";
import { appendUser, applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { mapCodexNotification } from "../../../integrations/harness/providers/codex/codexProtocol";
import { mismatchFixNudge } from "../../monos/model/mismatchFixNudge";
import { monoSpawnedSessions } from "../../monos/model/monoSpawnedSessions";
import { workerStartNudge } from "../../monos/model/workerStartNudge";
import { liveStep } from "./liveActivity";
import {
  delegateToolFailed,
  delegateToolLabel,
  delegateToolName,
  monoCodeToolCall,
  monoCodeWorkSummary,
} from "./monocodeToolCall";
import { newSession, type Block, type Session } from "./session";
import { toolCallLabel } from "./transcriptActivity";

type Call = {
  tool: string;
  status?: "inProgress" | "completed" | "failed";
  server?: string;
  args?: unknown;
  result?: unknown;
  error?: { message: string };
};

/** The blocks a Codex turn gets from these MCP calls: the real item mapper, then the real event reducer. */
function codexTurn(calls: Call[]): Session {
  let session = appendUser(newSession("codex", "/repo/vg-game"), "Ash's ask");
  calls.forEach((call, index) => {
    const item = {
      type: "mcpToolCall",
      id: `call-${index}`,
      server: call.server ?? "monocode",
      tool: call.tool,
      arguments: call.args ?? {},
    };
    const status = call.status ?? "completed";
    const started = mapCodexNotification("item/started", { item: { ...item, status: "inProgress" } });
    const settled =
      status === "inProgress"
        ? { events: [] }
        : mapCodexNotification("item/completed", {
            item: { ...item, status, result: call.result ?? null, error: call.error ?? null },
          });
    for (const event of [...started.events, ...settled.events]) session = applyHarnessEvent(session, event);
  });
  return session;
}

const toolBlocks = (session: Session): Block[] => session.blocks.filter((block) => block.role === "tool");
const rowOf = (call: Call): Block => toolBlocks(codexTurn([call]))[0];

const taskResult = (taskId: string, childSessionId: string) => ({
  content: [{ type: "text", text: JSON.stringify({ taskId, childSessionId, status: "running" }) }],
});
// r96: a goal or a file list must never become a file row ("Read README.md") on a delegate call.
const GOAL_ARGS = {
  title: "API health",
  brief: "Document GET /health. Check: npm test.",
  goal: "The README documents GET /health, and npm test passed.",
  files: ["README.md"],
};
const ROLL_UP =
  "Landed: `GET /health` returns 200 `{ alive: true }`. / Not fixed: the README still describes health as `{ ok: true, version }`, which is what the TODO asked for, not what the route returns.";

describe("a Codex lead's monocode calls", () => {
  it("are the shape Codex really sends: the server and the tool joined with a colon", () => {
    const row = rowOf({ tool: "delegate_task" });
    expect(row.tool?.title).toBe("monocode:delegate_task");
    expect(row.tool?.kind).toBe("other");
  });

  it("are recognized as the delegate tool's, for its own tools only", () => {
    for (const tool of [
      "delegate_task",
      "task_status",
      "task_wait",
      "task_cancel",
      "task_cannot",
      "task_answer",
      "task_accept",
      "task_message",
      "ask_person",
    ]) {
      expect(delegateToolName(rowOf({ tool }))).toBe(tool);
    }
    expect(delegateToolName(rowOf({ tool: "not_a_tool" }))).toBeUndefined();
    // Another server's tool of the same name is not the app's.
    expect(delegateToolName(rowOf({ tool: "delegate_task", server: "linear" }))).toBeUndefined();
    // Prose that names it is not a call.
    expect(
      delegateToolName({ id: "x", role: "assistant", text: "monocode:delegate_task" } as Block),
    ).toBeUndefined();
  });

  it("show the delegate card's words, in the present while running and the past once done", () => {
    const done = rowOf({ tool: "delegate_task" });
    expect(monoCodeToolCall(done)).toMatchObject({
      action: "delegate_task",
      delegate: "delegate_task",
      label: "Delegate a task",
    });
    expect(delegateToolLabel(done, "delegate_task")).toBe("Delegated a task");
    const running = rowOf({ tool: "delegate_task", status: "inProgress" });
    expect(delegateToolLabel(running, "delegate_task")).toBe("Delegating a task");
    expect(monoCodeWorkSummary([done], false)).toBe("Delegated 1 task");
  });

  it("read a failed call as a failure", () => {
    const refused = rowOf({ tool: "delegate_task", status: "failed", error: { message: "No such lead" } });
    expect(delegateToolFailed(refused)).toBe(true);
    expect(delegateToolLabel(refused, "delegate_task")).toBe("Tried to delegate a task");
  });

  it("link the worker it started, from the call's own result", () => {
    const launch = {
      sessionId: "app-lead-r1",
      cwd: "/repo/vg-game",
      title: "Fix the save bug",
      harness: "codex" as const,
      model: "codex:default",
    };
    const started = rowOf({ tool: "delegate_task", result: taskResult("t-1", "app-lead-r1") });
    expect(monoSpawnedSessions([started], [launch])).toEqual([launch]);
    // A call that only checks status starts nothing, so it links nothing.
    const checked = rowOf({ tool: "task_status", result: taskResult("t-1", "app-lead-r1") });
    expect(monoSpawnedSessions([checked], [launch])).toEqual([]);
  });

  it("show the activity labels, and never read the goal as a file", () => {
    const delegated = rowOf({ tool: "delegate_task", args: GOAL_ARGS });
    expect(delegated.tool?.preview).toBeUndefined();
    expect(toolCallLabel(delegated)).toBe("Delegated a task");
    expect(toolCallLabel(delegated)).not.toMatch(/npm test passed|README/);
    const running = codexTurn([{ tool: "delegate_task", status: "inProgress", args: GOAL_ARGS }]);
    expect(liveStep(running.blocks).label).toBe("Handing out a job");
    const waiting = codexTurn([{ tool: "task_wait", status: "inProgress" }]);
    expect(liveStep(waiting.blocks).label).toBe("Waiting on a worker");
  });

  it("stop the mismatch nudge from asking for a worker that was already started", () => {
    const lead = (calls: Call[]): Session => {
      const session = codexTurn(calls);
      const reply = { id: "a2", role: "assistant", text: ROLL_UP } as Block;
      return { ...session, busy: false, blocks: [...session.blocks, reply] };
    };
    expect(mismatchFixNudge(lead([]), new Set())?.id).toBe("fix-mismatch-a2");
    expect(mismatchFixNudge(lead([{ tool: "delegate_task" }]), new Set())).toBeUndefined();
    // A delegate that failed handed nothing out, so the lead is still nudged.
    expect(
      mismatchFixNudge(lead([{ tool: "delegate_task", status: "failed", error: { message: "no" } }]), new Set())?.id,
    ).toBe("fix-mismatch-a2");
  });

  it("stop the start-workers nudge from asking for a worker that was already started", () => {
    const dump =
      "ok so the privacy page for hivra needs doing. also stripe staging is broken i think. and reply to that store review. also look at who asked about hivra last week";
    const ash = { id: "u1", role: "user", text: dump, startedAt: 1_000 } as Block;
    const said = { id: "a1", role: "assistant", text: "Got all four. Starting now on the privacy page and Stripe." } as Block;
    const lead = (calls: Call[]): Session => ({
      ...newSession("codex", "/repo"),
      id: "lead",
      blocks: [ash, ...toolBlocks(codexTurn(calls)), said],
    });
    expect(workerStartNudge(lead([]), [], new Set())?.id).toBe("start-workers-u1");
    expect(workerStartNudge(lead([{ tool: "delegate_task" }]), [], new Set())).toBeUndefined();
    expect(
      workerStartNudge(lead([{ tool: "delegate_task", status: "failed", error: { message: "no" } }]), [], new Set())?.id,
    ).toBe("start-workers-u1");
  });
});
