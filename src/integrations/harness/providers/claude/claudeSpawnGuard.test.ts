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

const { CREDENTIAL_DENY_RULES } = await import("../../core/credentialGuard");
const { claudeGuardArgs, setClaudeGuardArgs } = await import("./claudeExtraArgs");
const { runClaudeTextPrompt, textCallToolArgs } = await import("./claudeText");
const { discoverClaudeModels } = await import("./claudeCatalog");
const { chatDeniedTools, monoHomeDeniedTools, monoHomeFenceArgs, registerClaudeGuards, registeredHubMcpArgs } = await import(
  "../../../../features/hub/model/hubMcp"
);

const FENCE = () => ["--disallowedTools", chatDeniedTools().join(",")];
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

  it("a helper call that streams into a chat is limited to its read tools and carries the fence", async () => {
    await expect(
      runClaudeTextPrompt({ cwd: "/p", prompt: "by the way?", onEvent: () => undefined }),
    ).rejects.toThrow();
    expect(noTools(spawned[0].args)).toBe(false);
    expect(hasFence(spawned[0].args)).toBe(true);
    expect(textCallToolArgs(false)).toEqual(["--tools", "", ...FENCE()]);
    // The allowlist first, then the five a side question may not use (see the side question block below) in the
    // fence's own list, behind it.
    expect(textCallToolArgs(true).slice(0, 2)).toEqual(["--tools", "Read,Grep,Glob"]);
    expect(textCallToolArgs(true)[2]).toBe("--disallowedTools");
    expect(textCallToolArgs(true)[3]).toBe([...chatDeniedTools(), "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"].join(","));
  });

  describe("a side question (the app's by-the-way call: streams into a chat, plan intent)", () => {
    // The same input App.tsx hands runHarnessTextPrompt, which hands it on to the Claude adapter untouched.
    const ask = () =>
      runClaudeTextPrompt({
        cwd: "/p",
        prompt: "What does this file do?",
        intent: "plan",
        model: "claude-sonnet-5-5",
        onEvent: () => undefined,
      });
    /** Every tool the CLI is told to deny, from each `--disallowedTools` it was given. */
    const denied = (args: string[]) =>
      args.flatMap((arg, i) => (args[i - 1] === "--disallowedTools" ? arg.split(",") : []));
    const lastList = (args: string[]) => args[args.lastIndexOf("--disallowedTools") + 1]?.split(",") ?? [];
    /** The tools the CLI is allowed to offer: the value after `--tools`. */
    const allowed = (args: string[]) => (args.includes("--tools") ? args[args.indexOf("--tools") + 1] : undefined);

    // A deny list only names what is known today: EnterWorktree creates a worktree and a branch in the project under
    // these flags (plan mode didn't stop it), and a tool added later would slip through the same way. Only what the CLI
    // is told it may use can't grow.
    it("is started with --tools Read,Grep,Glob, so every other tool is off its list", async () => {
      await expect(ask()).rejects.toThrow();
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args.filter((arg) => arg === "--tools")).toHaveLength(1);
      expect(allowed(spawned[0].args)).toBe("Read,Grep,Glob");
      // The allowlist comes with the deny list behind it, not instead of it.
      expect(spawned[0].args.indexOf("--tools")).toBeLessThan(spawned[0].args.lastIndexOf("--disallowedTools"));
    });

    it("has no tool outside that list, whichever tool the CLI adds later", async () => {
      await expect(ask()).rejects.toThrow();
      const list = (allowed(spawned[0].args) ?? "").split(",");
      expect(list.sort()).toEqual(["Glob", "Grep", "Read"]);
      for (const tool of ["EnterWorktree", "Agent", "Task", "WebFetch", "Skill"]) {
        expect(list, tool).not.toContain(tool);
      }
    });

    it("is started with Edit, Write, MultiEdit, NotebookEdit and Bash denied", async () => {
      await expect(ask()).rejects.toThrow();
      expect(spawned).toHaveLength(1);
      for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) {
        expect(denied(spawned[0].args), tool).toContain(tool);
      }
    });

    it("carries them in the same list as the fence, so one deny list never drops the other", async () => {
      await expect(ask()).rejects.toThrow();
      const last = lastList(spawned[0].args);
      for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", ...chatDeniedTools()]) {
        expect(last, tool).toContain(tool);
      }
    });

    it("still reads: Read, Grep and Glob stay on, none of them denied, and the fence", async () => {
      await expect(ask()).rejects.toThrow();
      expect(noTools(spawned[0].args)).toBe(false);
      expect(allowed(spawned[0].args)).toBe("Read,Grep,Glob");
      expect(denied(spawned[0].args)).not.toContain("Read");
      expect(denied(spawned[0].args)).not.toContain("Grep");
      expect(hasFence(spawned[0].args)).toBe(true);
      expect(spawned[0].args).toContain("plan");
    });

    it("denies them when the hub has registered no fence too", async () => {
      setClaudeGuardArgs(undefined);
      await expect(ask()).rejects.toThrow();
      for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) {
        expect(lastList(spawned[0].args), tool).toContain(tool);
      }
    });

    it("keeps the saved-login rules in that last list when there is no fence to share it with", async () => {
      setClaudeGuardArgs(undefined);
      await expect(ask()).rejects.toThrow();
      for (const rule of CREDENTIAL_DENY_RULES) {
        expect(lastList(spawned[0].args), rule).toContain(rule);
      }
    });

    it("leaves the helpers that need no tools as they were: no tools at all, not a deny list of five", async () => {
      await expect(runClaudeTextPrompt({ cwd: "/p", prompt: "Title this chat" })).rejects.toThrow();
      expect(noTools(spawned[0].args)).toBe(true);
      expect(textCallToolArgs(false)).toEqual(["--tools", "", ...FENCE()]);
    });
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
        // The guard may be in the call itself, or in an argument list the call spreads that is built in the same file
        // (`const launchArgs = [...]`): the Explore flag (WP-143) needs the list before the process starts.
        const spread = [...call.matchAll(/\.\.\.(\w+)\b/g)].flatMap(([, name]) => {
          const start = src.indexOf(`const ${name} = [`);
          return start < 0 ? [] : [src.slice(start, src.indexOf("\n  ];", start))];
        });
        const guarded = [call, ...spread].some((text) => /claudeExtraArgs\(|claudeGuardArgs\(|textCallToolArgs\(/.test(text));
        calls.push(`${file}: ${guarded ? "guarded" : "UNGUARDED"}`);
      }
    }
    expect(calls.sort()).toEqual([
      "claude.ts: guarded",
      "claudeCatalog.ts: guarded",
      "claudeText.ts: guarded",
    ]);
  });
});
