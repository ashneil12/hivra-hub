// Review repro for PR #194 round 5 (HIGH-C): a phase worker is a worker launch, so it passes the crew gate before its
// process starts. Today launchPhase calls host.start with no crew_launch_check, and relies on the spawn ticket alone.
import { expect, it } from "vitest";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import type { TaskHelpers } from "../../agent-app/model/agentAppTasks";
import type { Session } from "../../sessions/model/session";
import { counter } from "./machine";
import { deliverPhaseResult } from "./phaseBridge";
import { bindPhaseLauncher, unbindPhaseLauncher } from "./phaseCrew";
import { startPhaseWork } from "./store";

const PROJECT = "/tmp/phase-crew-gate";

it("does not start a phase worker on a CLI the crew gate refuses", async () => {
  const starts: string[] = [];
  const gated: string[] = [];
  const start: AgentAppHost["start"] = async (_launch, id) => {
    starts.push(id);
    deliverPhaseResult(id, { body: "A fact about the code." });
  };
  const host = {
    start,
    isMono: () => true,
    monoOf: () => ({ id: "mono", projects: [PROJECT] }),
    tasks: {
      crewGate: async (input: { cli: string }) => {
        gated.push(input.cli);
        throw new Error("OpenCode is on Never use, so it was not started.");
      },
    },
  } as unknown as AgentAppHost;
  const helpers = {
    startLaunch: (_source: Session, input: Record<string, unknown>) => ({
      prompt: String(input.prompt),
      cwd: PROJECT,
      harness: "opencode" as const,
      reveal: false,
    }),
    fileStarted: () => {},
  } as unknown as TaskHelpers;
  // The Lead's own chat runs on OpenCode (2.x talks to the OpenCode service, so no harness_spawn and no spawn ticket).
  const source = { id: "mono", cwd: PROJECT, harness: "opencode", model: "opencode:deepseek-v4-flash" } as Session;
  bindPhaseLauncher("task-gate", { source, host, helpers, requestId: "r-gate" });
  try {
    await startPhaseWork("task-gate", { weight: "costly" }, {}, counter());
    expect(gated.length).toBeGreaterThan(0);
    expect(starts).toEqual([]);
  } finally {
    unbindPhaseLauncher("task-gate");
  }
});
