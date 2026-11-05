// WP-84: a dev copy runs a phase with the fake Claude. This never starts a real login.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { finishRun, phaseBrief, type FinishResult, type Run, type Work } from "./machine";

export function fakeClaudeLaunch(scenarioFile: string, stateDir: string, sessionId: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: process.execPath,
    args: [resolve("scripts/fake-claude.mjs"), "--session-id", sessionId],
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioFile, FAKE_CLAUDE_STATE: stateDir },
  };
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
  const prompt = [`Skill: ${run.skill}`, `Task: ${work.taskId}`, phaseBrief(work)].filter(Boolean).join("\n");
  const reply = await askFakeClaude(prompt, fakeClaudeLaunch(scenarioFile, stateDir, run.sessionId), timeoutMs);
  return finishRun(work, work.version, run.id, reply, ids);
}
