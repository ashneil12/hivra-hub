// WP-84: a dev copy runs a phase with the fake Claude. This never starts a real login.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { finishRun, phaseBrief, type FinishResult, type Run, type Work } from "./machine";
import { skillText } from "./skillText";

/** The child gets the scenario and its state directory, and nothing else from this process. */
export function fakeClaudeLaunch(scenarioFile: string, stateDir: string, sessionId: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: process.execPath,
    args: [resolve("scripts/fake-claude.mjs"), "--session-id", sessionId],
    env: {
      FAKE_CLAUDE_SCENARIO: scenarioFile,
      FAKE_CLAUDE_STATE: stateDir,
    },
  };
}

/** The prompt for one phase run. The skill file is included when it is on disk. */
export function phasePrompt(work: Work, run: Run, text?: string): string {
  const parts = [
    `Skill: ${run.skill}`,
    text?.trim() || undefined,
    `Task: ${work.taskId}`,
    run.steering.length > 0 ? `The person's words:\n${run.steering.join("\n")}` : undefined,
    phaseBrief(work),
    run.docNumber != null ? `Edit document ${run.docNumber}. Do not start a new one.` : undefined,
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

/** The fake's reply, or a timeout. A timeout is not a finished phase. */
export function askFakeClaude(prompt: string, launch: ReturnType<typeof fakeClaudeLaunch>, timeoutMs: number): Promise<FinishResult> {
  return new Promise((done) => {
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const finish = (result: FinishResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      done(result);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    child.on("error", () => finish({ unreachable: true }));
    child.on("exit", () => finish({ unreachable: true }));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.startsWith("{")) return;
      try {
        const frame = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean };
        if (frame.type === "result" && frame.is_error) finish({ unreachable: true });
        else if (frame.type === "result") finish({ body: frame.result ?? "" });
      } catch {
        // A bad line is not a document.
      }
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ type: "control_request", request_id: "phase", request: { subtype: "initialize" } });
    send({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null });
  });
}

export async function finishFromFake(work: Work, run: Run, scenarioFile: string, stateDir: string, ids: () => string, timeoutMs = 8_000): Promise<{ stale: boolean; work: Work }> {
  const prompt = phasePrompt(work, run, skillText(run.skill));
  const reply = await askFakeClaude(prompt, fakeClaudeLaunch(scenarioFile, stateDir, run.sessionId), timeoutMs);
  return finishRun(work, work.version, run.id, reply, ids);
}
