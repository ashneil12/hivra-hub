import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { steerLine } from "../../../../plugins/hivra-mirror/src/steer.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const fake = path.join(repo, "scripts", "fake-claude.mjs");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "hivra-mirror-"));
  dirs.push(dir);
  return dir;
}

function childEnv(dir: string, scenario: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_SCENARIO: scenario };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

function start(dir: string, rules: unknown) {
  const scenario = path.join(dir, "rules.json");
  writeFileSync(scenario, JSON.stringify({ version: 1, rules }));
  const child = spawn(process.execPath, [fake, "--output-format", "stream-json", "--session-id", "term-1"], {
    cwd: dir,
    env: childEnv(dir, scenario),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let seen = 0;
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (!line.startsWith("{")) return;
    frames.push(JSON.parse(line) as Record<string, unknown>);
    for (const waiter of [...waiters]) waiter();
  });
  const until = (predicate: (frame: Record<string, unknown>) => boolean, label: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${label}`));
      }, 8_000);
      const check = () => {
        const index = frames.findIndex((frame, i) => i >= seen && predicate(frame));
        if (index < 0) return;
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(check), 1);
        seen = index + 1;
        resolve(frames[index]!);
      };
      waiters.push(check);
      check();
    });
  const write = (line: string) => child.stdin!.write(`${line}\n`);
  return { child, frames, until, write };
}

describe("steering through the fake", () => {
  it("delivers a reply, a stop and a permission answer", async () => {
    const dir = scratch();
    const question = { question: "Go?", header: "Go", multiSelect: false, options: [{ label: "Yes" }] };
    const session = start(dir, [
      { name: "reply", match: "REPLY-PLEASE", steps: [{ say: "HEARD" }] },
      { name: "hold", match: "HOLD", steps: [{ say: "Working." }, { waitFile: "never", timeoutMs: 20_000 }] },
      {
        name: "ask",
        match: "ASK",
        steps: [{ ask: { questions: [question], mark: "perm" } }, { say: "AFTER" }],
      },
    ]);
    session.write(JSON.stringify({ type: "control_request", request_id: "init", request: { subtype: "initialize" } }));
    await session.until((frame) => frame.type === "control_response", "initialize");

    session.write(steerLine({ kind: "reply", text: "REPLY-PLEASE" }));
    const heard = await session.until((frame) => frame.type === "result" && frame.result === "HEARD", "reply");
    expect(heard.result).toBe("HEARD");

    session.write(steerLine({ kind: "reply", text: "HOLD" }));
    await session.until((frame) => frame.type === "assistant", "working");
    session.write(steerLine({ kind: "stop" }));
    const stopped = await session.until(
      (frame) => frame.type === "result" && frame.terminal_reason === "aborted",
      "stop",
    );
    expect(stopped.terminal_reason).toBe("aborted");

    session.write(steerLine({ kind: "reply", text: "ASK" }));
    const asked = await session.until((frame) => frame.type === "control_request", "permission");
    const request = asked.request as { subtype?: string };
    expect(request.subtype).toBe("can_use_tool");
    session.write(
      steerLine({
        kind: "permission",
        requestId: String(asked.request_id),
        allow: true,
        answers: { "Go?": "Yes" },
      }),
    );
    await session.until((frame) => frame.type === "result" && frame.result === "AFTER", "after");
    const mark = JSON.parse(readFileSync(path.join(dir, "marks", "perm.json"), "utf8")) as { answered: boolean };
    expect(mark.answered).toBe(true);

    session.child.stdin!.end();
    const code = await new Promise<number | null>((resolve) => session.child.on("exit", resolve));
    expect(code).toBe(0);
  });
});
