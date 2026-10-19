import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyHarnessSettings,
  registerHarness,
  resetHarnessIdlePark,
  sendHarnessTurn,
  stopHarnessTask,
  type HarnessAdapter,
} from "./registry";
import {
  resetWorkflowActivity,
  runningWorkflows,
} from "../../../features/sessions/model/workflowActivity";
import type { WorkflowRunMeta } from "../../../features/sessions/model/workflowRun";

const run: WorkflowRunMeta = {
  taskId: "w1",
  status: "running",
  phases: [{ index: 1, title: "Scan" }],
  agents: [],
};

afterEach(() => {
  resetWorkflowActivity();
  resetHarnessIdlePark();
});

describe("the registry for long-running Leads", () => {
  it("keeps a turn's running workflows for views outside the chat, until the turn ends", async () => {
    let finish: () => void = () => undefined;
    let seenDuringTurn: WorkflowRunMeta[] = [];
    const adapter = {
      id: "claude",
      live: true,
      sendTurn: async (input) => {
        input.onEvent({ type: "workflow.progress", callId: "toolu_1", run });
        seenDuringTurn = runningWorkflows(input.sessionId);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      steerTurn: async () => undefined,
      cancelTurn: async () => undefined,
      respondApproval: () => undefined,
      stopSession: async () => undefined,
      forgetSession: async () => undefined,
      bindSession: () => undefined,
    } satisfies HarnessAdapter;
    registerHarness(adapter);
    const events: unknown[] = [];
    const turn = sendHarnessTurn({
      harness: "claude",
      sessionId: "lead",
      cwd: "/repo",
      model: "claude:claude-opus-5-5",
      runtimeMode: "supervised",
      text: "go",
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(seenDuringTurn).toEqual([run]));
    expect(events).toContainEqual({ type: "workflow.progress", callId: "toolu_1", run });
    finish();
    await turn;
    expect(runningWorkflows("lead")).toEqual([]);
  });

  it("hands Stop for one task and live settings to the adapter, and says idle without one", async () => {
    const stopTask = vi.fn(async () => true);
    const applySettings = vi.fn(async () => "applied" as const);
    registerHarness({
      id: "claude",
      live: true,
      sendTurn: async () => undefined,
      steerTurn: async () => undefined,
      cancelTurn: async () => undefined,
      respondApproval: () => undefined,
      stopSession: async () => undefined,
      forgetSession: async () => undefined,
      bindSession: () => undefined,
      stopTask,
      applySettings,
    });
    expect(await stopHarnessTask("claude", "lead", "w1")).toBe(true);
    expect(stopTask).toHaveBeenCalledWith("lead", "w1");
    const input = { harness: "claude" as const, sessionId: "lead", model: "m", runtimeMode: "full-access" as const };
    expect(await applyHarnessSettings(input)).toBe("applied");
    expect(applySettings).toHaveBeenCalledWith(input);
    expect(await applyHarnessSettings({ ...input, harness: "codex" })).toBe("idle");
    expect(await stopHarnessTask("codex", "lead", "w1")).toBe(false);
  });
});
