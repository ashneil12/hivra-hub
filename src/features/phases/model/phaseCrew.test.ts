import { expect, it } from "vitest";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import type { TaskHelpers } from "../../agent-app/model/agentAppTasks";
import type { Session } from "../../sessions/model/session";
import { counter } from "./machine";
import { deliverPhaseResult } from "./phaseBridge";
import { bindPhaseLauncher, unbindPhaseLauncher } from "./phaseCrew";
import { startPhaseWork } from "./store";

const PROJECT = "/tmp/phase-crew";

function launcher(start: AgentAppHost["start"], requestId: string) {
  const host = { start } as AgentAppHost;
  const helpers = {
    startLaunch: (_source: Session, input: Record<string, unknown>) => ({
      prompt: String(input.prompt),
      cwd: PROJECT,
      harness: "claude" as const,
      reveal: false,
    }),
    fileStarted: () => {},
  } as unknown as TaskHelpers;
  const source = { id: "mono", cwd: PROJECT, harness: "claude", model: "claude:opus-5-5" } as Session;
  return { source, host, helpers, requestId };
}

it("starts one worker for a run when a second ask overlaps it", async () => {
  const starts: string[] = [];
  let overlapped: Promise<unknown> = Promise.resolve();
  const start: AgentAppHost["start"] = async (_launch, id) => {
    starts.push(id);
    if (starts.length === 1) {
      overlapped = startPhaseWork("task-overlap", { weight: "costly" }, { continueWithoutWaiting: false }, counter());
      await Promise.resolve();
    }
    deliverPhaseResult(id, { body: "A fact about the code." });
  };
  bindPhaseLauncher("task-overlap", launcher(start, "r1"));
  bindPhaseLauncher("task-overlap", launcher(start, "r2"));
  try {
    const work = await startPhaseWork("task-overlap", { weight: "costly" }, { continueWithoutWaiting: false }, counter());
    await overlapped;
    expect(starts).toHaveLength(2);
    expect(starts.every((id) => id.startsWith("app-mono-r1-phase-"))).toBe(true);
    expect(work?.docs).toHaveLength(2);
    expect(work?.waiting?.phase).toBe("research");
    expect(work?.building).toBe(false);
  } finally {
    unbindPhaseLauncher("task-overlap");
    unbindPhaseLauncher("task-overlap");
  }
});

it("does not start a worker for a task nothing has bound", async () => {
  const starts: string[] = [];
  bindPhaseLauncher("task-other", launcher(async (_launch, id) => {
    starts.push(id);
  }, "r-other"));
  const work = await startPhaseWork("task-nobody", { weight: "costly" }, {}, counter());
  expect(starts).toEqual([]);
  expect(work?.docs).toEqual([]);
  expect(work?.runs.at(-1)?.status).toBe("retry");
});
