// Every Claude Code process the app starts carries the fence round the Monos' home, or has no tools at all (Mac round 2,
// 21 Oct: each chat also started a claude-haiku-4-5 title helper with no --disallowedTools). Three ways start one: a
// chat (claude.ts, its extra arguments from the hub), the app's text helper (claudeText.ts) and the model-catalog probe
// (claudeCatalog.ts). The source check below fails if a fourth appears without the guard.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: { id: string; args: string[] }[] = [];

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (id: string, _path: string, args: string[]) => {
    spawned.push({ id, args });
    throw new Error("stand-in: not started");
  },
  execChild: async () => "2.1.304 (Claude Code)",
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: () => undefined,
  writeChild: async () => undefined,
}));
vi.mock("../../../../platform/tauri/fs", () => ({ homeDir: async () => "/Users/ash" }));
vi.mock("../../../../features/sessions/model/models", async (orig) => ({
  ...(await orig<object>()),
  modelsFor: () => [],
  setHarnessModels: () => undefined,
}));

const { claudeGuardArgs, setClaudeGuardArgs } = await import("./claudeExtraArgs");
const { runClaudeTextPrompt, textCallToolArgs } = await import("./claudeText");
const { discoverClaudeModels } = await import("./claudeCatalog");
const { monoHomeDeniedTools, monoHomeFenceArgs, registerClaudeGuards, registeredHubMcpArgs } = await import(
  "../../../../features/hub/model/hubMcp"
);

const FENCE = () => ["--disallowedTools", monoHomeDeniedTools().join(",")];
const hasFence = (args: string[]) => {
  const i = args.lastIndexOf("--disallowedTools");
  return i >= 0 && monoHomeDeniedTools().every((rule) => args[i + 1]?.split(",").includes(rule));
};
const noTools = (args: string[]) => {
  const i = args.indexOf("--tools");
  return i >= 0 && args[i + 1] === "";
};

beforeEach(() => {
  spawned.length = 0;
  registerClaudeGuards();
});
afterEach(() => setClaudeGuardArgs(undefined));

describe("the guard on every Claude process", () => {
  it("is the hub's Monos-home fence once the hub registers it", () => {
    expect(monoHomeFenceArgs()).toEqual(FENCE());
    expect(claudeGuardArgs()).toEqual(FENCE());
    setClaudeGuardArgs(undefined);
    expect(claudeGuardArgs()).toEqual([]);
  });

  it("a chat: fenced even before the hub's servers are read", () => {
    expect(hasFence(registeredHubMcpArgs("any-chat"))).toBe(true);
  });

  it("the title helper (claude-haiku-4-5, no tools needed): no tools at all, and the fence", async () => {
    await expect(runClaudeTextPrompt({ cwd: "/p", prompt: "Title this chat" })).rejects.toThrow();
    const [call] = spawned;
    expect(call.args).toContain("claude-haiku-4-5");
    expect(noTools(call.args)).toBe(true);
    expect(hasFence(call.args)).toBe(true);
  });

  it("a helper call that streams into a chat keeps its tools but carries the fence", async () => {
    await expect(
      runClaudeTextPrompt({ cwd: "/p", prompt: "by the way?", onEvent: () => undefined }),
    ).rejects.toThrow();
    expect(noTools(spawned[0].args)).toBe(false);
    expect(hasFence(spawned[0].args)).toBe(true);
    expect(textCallToolArgs(false)).toEqual(["--tools", "", ...FENCE()]);
    expect(textCallToolArgs(true)).toEqual(FENCE());
  });

  it("the model-catalog probe: no tools, and the fence", async () => {
    await discoverClaudeModels("/p");
    const probe = spawned.find((s) => s.args.includes("--no-session-persistence"))!;
    expect(probe).toBeDefined();
    expect(noTools(probe.args)).toBe(true);
    expect(hasFence(probe.args)).toBe(true);
  });

  it("no way of starting Claude in the app's source leaves the guard off", () => {
    const dir = __dirname;
    const calls: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const src = readFileSync(join(dir, file), "utf8");
      for (let at = src.indexOf("spawnChild("); at >= 0; at = src.indexOf("spawnChild(", at + 1)) {
        // The call's own text, up to its closing parenthesis.
        let depth = 0;
        let end = at + "spawnChild".length;
        for (; end < src.length; end += 1) {
          if (src[end] === "(") depth += 1;
          else if (src[end] === ")" && --depth === 0) break;
        }
        const call = src.slice(at, end + 1);
        calls.push(`${file}: ${/claudeExtraArgs\(|claudeGuardArgs\(|textCallToolArgs\(/.test(call) ? "guarded" : "UNGUARDED"}`);
      }
    }
    expect(calls.sort()).toEqual([
      "claude.ts: guarded",
      "claudeCatalog.ts: guarded",
      "claudeText.ts: guarded",
    ]);
  });
});
