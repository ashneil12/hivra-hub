import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";

/**
 * The live Claude adapter against scripts/fake-claude.mjs as a real child process (Phase 1b WP5): the same
 * stream-json the installed CLI speaks, a conversation kept on disk between processes, and a deleted one answered the
 * way Claude Code 2.1.302 answers it. Only the Tauri child-process plumbing is swapped for node's.
 */

const FAKE = fileURLToPath(new URL("../../../../../scripts/fake-claude.mjs", import.meta.url));
const children = new Map<string, ChildProcess>();
const spawned: string[][] = [];
const watchers = new Map<
  string,
  { line: (l: string) => void; exit: (code?: number | null) => void }
>();
let env: Record<string, string> = {};

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (id: string, _path: string, args: string[], cwd: string) => {
    spawned.push(args);
    const child = spawn(process.execPath, [FAKE, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.set(id, child);
    createInterface({ input: child.stdout! }).on("line", (line) =>
      watchers.get(id)?.line(line),
    );
    child.on("exit", (code) => {
      if (children.get(id) === child) children.delete(id);
      watchers.get(id)?.exit(code);
    });
  },
  killChild: async (id: string) => {
    children.get(id)?.kill();
    children.delete(id);
  },
  unwatchChild: (id: string) => watchers.delete(id),
  watchChild: (
    id: string,
    line: (l: string) => void,
    exit: (code?: number | null) => void,
  ) => watchers.set(id, { line, exit }),
  writeChild: async (id: string, line: string) => {
    children.get(id)?.stdin?.write(`${line}\n`);
  },
}));

const {
  RECOVERED_FROM_BRIEF,
  bindClaudeSession,
  sendClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");

let state = "";

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "fake-claude-adapter-"));
  const rules = join(state, "rules.json");
  writeFileSync(
    rules,
    JSON.stringify({
      version: 1,
      rules: [
        {
          name: "work",
          match: "audit",
          steps: [
            { say: "Starting a subagent." },
            { background: { id: "agent-7", kind: "subagent", description: "Audit math.ts" } },
            { sleep: 50 },
            { finishBackground: "agent-7" },
            { say: "AUDIT-DONE" },
          ],
        },
        { name: "brief", match: "<brief>", steps: [{ say: "PICKED-UP" }] },
        { name: "plain", match: ".", steps: [{ say: "OK" }] },
      ],
    }),
  );
  env = { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_SCENARIO: rules };
  spawned.length = 0;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("chat");
  for (const child of children.values()) child.kill();
  children.clear();
  rmSync(state, { recursive: true, force: true });
});

function turn(text: string, events: HarnessEvent[]) {
  return sendClaudeTurn({
    sessionId: "chat",
    cwd: tmpdir(),
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "full-access",
    text,
    attachments: [],
    resumeFallback: (prompt) => `<brief>chat so far</brief>\n\n${prompt}`,
    onEvent: (event) => events.push(event),
  });
}

const reply = (events: HarnessEvent[]) =>
  events
    .filter((e): e is Extract<HarnessEvent, { type: "message.delta" }> => e.type === "message.delta")
    .map((e) => e.text)
    .join("");

describe("the live adapter against the fake Claude CLI", () => {
  it("runs a turn with background work and reports it with its id", async () => {
    const events: HarnessEvent[] = [];
    await turn("audit math.ts", events);
    expect(reply(events)).toContain("AUDIT-DONE");
    const work = events.filter(
      (e): e is Extract<HarnessEvent, { type: "background.work" }> => e.type === "background.work",
    );
    expect(work.flatMap((e) => e.work)).toContainEqual({
      kind: "subagent",
      label: "Audit math.ts",
      id: "agent-7",
    });
    expect(work.at(-1)!.work).toEqual([]);
    expect(events.some((e) => e.type === "session.error")).toBe(false);
  }, 20_000);

  it("resumes the same conversation after a restart, and starts fresh from the brief when its transcript is gone", async () => {
    const first: HarnessEvent[] = [];
    await turn("hello", first);
    const bound = first.find(
      (e): e is Extract<HarnessEvent, { type: "session.providerBound" }> =>
        e.type === "session.providerBound",
    )!.providerSessionId;

    // The app restarts: a new process resumes the saved conversation.
    await stopClaudeSession("chat");
    __claudeTestReset();
    bindClaudeSession("chat", bound, tmpdir());
    const resumed: HarnessEvent[] = [];
    await turn("hello again", resumed);
    expect(spawned.at(-1)).toContain("--resume");
    expect(reply(resumed)).toBe("OK");
    expect(resumed.some((e) => e.type === "session.providerLost")).toBe(false);

    // Its transcript is deleted while the app is down.
    await stopClaudeSession("chat");
    __claudeTestReset();
    rmSync(join(state, "conversations", `${bound}.json`));
    bindClaudeSession("chat", bound, tmpdir());
    const recovered: HarnessEvent[] = [];
    await turn("where were we?", recovered);
    expect(recovered.find((e) => e.type === "session.providerLost")).toMatchObject({
      providerSessionId: bound,
      text: RECOVERED_FROM_BRIEF,
    });
    expect(recovered.some((e) => e.type === "session.error")).toBe(false);
    expect(reply(recovered)).toBe("PICKED-UP");
    const fresh = recovered.filter(
      (e): e is Extract<HarnessEvent, { type: "session.providerBound" }> =>
        e.type === "session.providerBound",
    );
    expect(fresh.at(-1)!.providerSessionId).not.toBe(bound);
    const prompts = readFileSync(join(state, "prompts.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { prompt: string; rule: string });
    expect(prompts.at(-1)).toMatchObject({
      rule: "brief",
      prompt: "<brief>chat so far</brief>\n\nwhere were we?",
    });
  }, 30_000);
});
