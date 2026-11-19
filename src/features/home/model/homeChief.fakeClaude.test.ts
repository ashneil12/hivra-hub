import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { setMonoChatOpener } from "../../hub/model/hubNav";
import { openChiefChat } from "./chief";
import type { ExchangeBlock } from "./exchange";
import { latestExchange } from "./exchange";
import { sendHomeTurn, setHomeChiefHost } from "./homeChief";

const FAKE = fileURLToPath(new URL("../../../../scripts/fake-claude.mjs", import.meta.url));
const children = new Map<string, ChildProcess>();
let env: Record<string, string> = {};

vi.mock("../../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (id: string, _path: string, args: string[], cwd: string) => {
    const child = spawn(process.execPath, [FAKE, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.set(id, child);
    createInterface({ input: child.stdout! }).on("line", (line) => watchers.get(id)?.line(line));
    child.on("exit", (code) => {
      if (children.get(id) !== child) return;
      children.delete(id);
      watchers.get(id)?.exit(code);
    });
  },
  killChild: async (id: string) => {
    children.get(id)?.kill();
    children.delete(id);
  },
  unwatchChild: (id: string) => watchers.delete(id),
  watchChild: (id: string, line: (value: string) => void, exit: (code?: number | null) => void) => {
    watchers.set(id, { line, exit });
  },
  writeChild: async (id: string, line: string) => {
    children.get(id)?.stdin?.write(`${line}\n`);
  },
}));

const watchers = new Map<string, { line: (value: string) => void; exit: (code?: number | null) => void }>();

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import("../../../integrations/harness/providers/claude/claude");

let state = "";

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "home-chief-"));
  const rules = join(state, "rules.json");
  writeFileSync(rules, JSON.stringify({
    version: 1,
    rules: [{ name: "exo", match: "how is EXO going\\?", steps: [{ say: "EXO is fine." }] }],
  }));
  env = { FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_SCENARIO: rules };
  __claudeTestReset();
});

afterEach(async () => {
  setHomeChiefHost(undefined);
  await stopClaudeSession("chief-session");
  for (const child of children.values()) child.kill();
  children.clear();
  rmSync(state, { recursive: true, force: true });
});

it("sends one turn to the chief's session and streams the reply, filing nothing", async () => {
  const blocks: ExchangeBlock[] = [];
  const submitted: string[] = [];
  let tasks = 0;
  setHomeChiefHost({
    ensure: async (monoId) => (monoId === "chief-1" ? { id: "chief-session" } : undefined),
    submit: async (sessionId, text) => {
      submitted.push(`${sessionId}:${text}`);
      blocks.push({ role: "user", text });
      const events: HarnessEvent[] = [];
      await sendClaudeTurn({
        sessionId,
        cwd: tmpdir(),
        model: "claude:claude-sonnet-5",
        modelSettings: {},
        runtimeMode: "full-access",
        text,
        attachments: [],
        resumeFallback: (prompt) => prompt,
        onEvent: (event) => events.push(event),
      });
      const reply = events
        .filter((event): event is Extract<HarnessEvent, { type: "message.delta" }> => event.type === "message.delta")
        .map((event) => event.text)
        .join("");
      blocks.push({ role: "assistant", text: reply });
      return true;
    },
    answer: () => undefined,
    read: () => ({ id: "chief-session", blocks }),
  });

  const result = await sendHomeTurn("chief-1", "how is EXO going?");
  expect(result).toEqual({ ok: true, sessionId: "chief-session" });
  expect(submitted).toEqual(["chief-session:how is EXO going?"]);
  expect(latestExchange(blocks).reply).toBe("EXO is fine.");
  expect(tasks).toBe(0);

  const opened: string[] = [];
  setMonoChatOpener((id) => opened.push(id));
  openChiefChat("chief-1");
  expect(opened).toEqual(["chief-1"]);

  const view = readFileSync(fileURLToPath(new URL("../ui/HomeView.tsx", import.meta.url)), "utf8");
  expect(view).not.toContain("fileIntoProject");
  expect(view).not.toContain("askChief");
  expect(view).not.toContain("tasks_create");
  expect(view).not.toContain("createHomeAsks");
  expect(() => readFileSync(fileURLToPath(new URL("./ask.ts", import.meta.url)))).toThrow();
});
