// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Ash (21 Oct): "switch the runtime as well to cc running grok 4.7 … via sub". With Claude Code's CLI path on the
 * Grok bridge launcher (`claude-grok`), every Claude Code process, chats and the hub's own helper calls alike, asks
 * for Grok 4.7 with a level Grok has, and nothing goes through the "Other models" router.
 */

let cliPath: string | null = null;
vi.mock("../../../../features/providers/model/providerBinaryPaths", () => ({
  runtimeProviderBinaryPath: (provider: string) => (provider === "claude" ? cliPath : null),
  loadProviderBinaryPath: () => cliPath,
  providerBinaryPathChangePending: () => false,
  saveProviderBinaryPath: () => true,
}));

const sent: string[] = [];
const spawned: { args: string[]; route?: Record<string, unknown> }[] = [];
let onLine: ((line: string) => void) | undefined;
vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: cliPath ?? "/fake/claude" }),
  spawnChild: async (
    _id: string, _path: string, args: string[], _cwd: string, _account: unknown, _bp: unknown, _cs: unknown, _devin: unknown,
    route?: Record<string, unknown>,
  ) => {
    spawned.push({ args, route });
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const { claudeRunsOnGrok, grokBridgeEffort, GROK_BRIDGE_MODEL } = await import("./claudeGrokBridge");
const { buildClaudeSpawnArgs } = await import("./claudeProtocol");
const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import("./claude");

const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const parse = () => sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function oneTurn(model: string, effort: string) {
  const done = sendClaudeTurn({
    sessionId: `s-${model}-${effort}`, cwd: "/repo", model, modelSettings: { effort }, runtimeMode: "supervised",
    text: "hello", attachments: [], onEvent: () => undefined,
  });
  const initSent = () => parse().some((m) => (m.request as { subtype?: string })?.subtype === "initialize");
  await waitFor(initSent, "initialize");
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  const init = parse().filter((m) => (m.request as { subtype?: string })?.subtype === "initialize").at(-1)!;
  emit({ type: "control_response", response: { subtype: "success", request_id: init.request_id } });
  await waitFor(() => parse().some((m) => m.type === "user"), "prompt");
  emit({ type: "assistant", session_id: "sess_1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Hi." }] } });
  emit({ type: "result", subtype: "success", session_id: "sess_1", num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  await done;
  await stopClaudeSession(`s-${model}-${effort}`);
}

afterEach(() => {
  cliPath = null;
  sent.length = 0;
  spawned.length = 0;
  __claudeTestReset?.();
});

describe("Claude Code on Grok 4.7 through the Grok subscription", () => {
  it("is on only when Claude Code's CLI is the bridge launcher", () => {
    expect(claudeRunsOnGrok(null)).toBe(false);
    expect(claudeRunsOnGrok("/Users/ash/.local/bin/claude")).toBe(false);
    expect(claudeRunsOnGrok("/Users/ash/.local/bin/claude-gpt")).toBe(false);
    expect(claudeRunsOnGrok("/Users/ash/.local/bin/claude-grok")).toBe(true);
  });

  it("gives Grok only the levels it has", () => {
    expect(grokBridgeEffort("max")).toBe("xhigh");
    expect(grokBridgeEffort("xhigh")).toBe("xhigh");
    expect(grokBridgeEffort("medium")).toBe("medium");
    expect(grokBridgeEffort(undefined)).toBeUndefined();
  });

  it("leaves Claude Code alone on the normal CLI", () => {
    const args = buildClaudeSpawnArgs({ model: "claude-opus-5-5", effort: "max", isolated: true });
    expect(flag(args, "--model")).toBe("claude-opus-5-5");
    expect(flag(args, "--effort")).toBe("max");
  });

  it("asks for Grok 4.7 in the hub's own helper calls (titles, gates) on the bridge", () => {
    cliPath = "/Users/ash/.local/bin/claude-grok";
    const args = buildClaudeSpawnArgs({ model: "claude-haiku-4-5", effort: "max", isolated: true });
    expect(flag(args, "--model")).toBe(GROK_BRIDGE_MODEL);
    expect(flag(args, "--effort")).toBe("xhigh");
  });

  it("starts a chat on Grok 4.7 whatever Claude model it picked, and never through the Other models router", async () => {
    cliPath = "/Users/ash/.local/bin/claude-grok";
    await oneTurn("claude-opus-5-5", "high");
    expect(flag(spawned[0]!.args, "--model")).toBe("grok-4.7");
    expect(flag(spawned[0]!.args, "--effort")).toBe("high");
    expect(spawned[0]!.route).toBeUndefined();
  });

  it("r61 (PM, item 7): a DeepSeek worker on the bridge starts at the high effort it was given", async () => {
    cliPath = "/Users/ash/.local/bin/claude-grok";
    await oneTurn("deepseek-v4.1-flash", "high");
    expect(flag(spawned[0]!.args, "--model")).toContain("deepseek");
    expect(flag(spawned[0]!.args, "--effort")).toBe("high");
  });

  it("a chat on the normal CLI still starts on the Claude model it picked", async () => {
    await oneTurn("claude-opus-5-5", "high");
    expect(flag(spawned[0]!.args, "--model")).not.toBe("grok-4.7");
    expect(flag(spawned[0]!.args, "--model")).toContain("claude");
  });
});

describe("claudeRunsOnGrok on the real bench", () => {
  it("is on Grok when the bench's plan says so, whatever its wrapper is called", () => {
    expect(claudeRunsOnGrok("/tmp/run/bin/claude", true)).toBe(true);
    expect(claudeRunsOnGrok("/tmp/run/bin/claude", false)).toBe(false);
  });
});

describe("the model pill on Grok", () => {
  it("says Grok 4.7 for any Claude Code model on Grok, and the model's own name otherwise", async () => {
    const { claudePillName } = await import("./claudeGrokBridge");
    expect(claudePillName("Gemini 4 Argon", true)).toBe("Grok 4.7");
    expect(claudePillName("Claude Sonnet 5", true)).toBe("Grok 4.7");
    expect(claudePillName("Claude Sonnet 5", false)).toBe("Sonnet 5");
  });
});

it("session rows, cards and tabs say Grok 4.7 for a Claude Code chat on Grok, and leave other engines alone", async () => {
  const { shownModelName } = await import("./claudeGrokBridge");
  expect(shownModelName("claude", "Claude Sonnet 5", true)).toBe("Grok 4.7");
  expect(shownModelName("claude", "Claude Sonnet 5", false)).toBe("Claude Sonnet 5");
  expect(shownModelName("codex", "GPT-5.5", true)).toBe("GPT-5.5");
});

describe("the model in use, as the model line and the turn header both name it", () => {
  afterEach(() => {
    cliPath = null;
  });
  it("on the bridge a Claude Code chat reads Grok 4.7 whatever Claude model it names; off it, the name given", async () => {
    const { modelInUseLabel, onGrokBridge, GROK_BRIDGE_LABEL } = await import("./claudeGrokBridge");
    expect(GROK_BRIDGE_LABEL).toBe("Grok 4.7");
    expect(modelInUseLabel("claude", "Claude Sonnet 5")).toBe("Claude Sonnet 5");
    expect(onGrokBridge("claude")).toBe(false);
    cliPath = "/Users/example/.local/bin/claude-grok";
    expect(onGrokBridge("claude")).toBe(true);
    expect(modelInUseLabel("claude", "Claude Sonnet 5")).toBe("Grok 4.7");
    // Other harnesses and a turn with no model name are left as they are.
    expect(onGrokBridge("codex")).toBe(false);
    expect(modelInUseLabel("codex", "GPT-5.5")).toBe("GPT-5.5");
    expect(modelInUseLabel("claude", undefined)).toBeUndefined();
  });
});

/**
 * Alfred (27 Oct, on 0.16.0): every Mono still named claude:sonnet-5 or claude:haiku, and the launcher passes a name
 * it doesn't know to the gateway as it is; on 14 Oct a claude-sonnet-5 request went to a third-party provider. On a
 * bridge every process now asks for Grok 4.7 or DeepSeek by the launcher's own name, and a model it can't place fails
 * before anything starts.
 */
describe("every model a bridge process asks for is Grok 4.7 or DeepSeek, or it doesn't start", () => {
  const CLAUDE_ALIASES = [
    "sonnet", "opus", "haiku", "fable", "claude", "default",
    "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]", "claude-opus-5-5", "claude-opus-4-8",
    "claude-haiku-4-5", "claude-fable-5", "claude-3-5-sonnet-latest", "claude:sonnet-5", "claude:haiku", "Sonnet-5",
    "anthropic/claude-sonnet-4.5",
  ];

  it("runs every Claude alias, with or without a version, as Grok 4.7 on the Grok bridge", () => {
    cliPath = "/Users/ash/.local/bin/claude-grok";
    for (const model of CLAUDE_ALIASES) {
      expect([model, flag(buildClaudeSpawnArgs({ model, isolated: true }), "--model")]).toEqual([model, "grok-4.7"]);
    }
    expect(flag(buildClaudeSpawnArgs({ isolated: true }), "--model")).toBe("grok-4.7");
  });

  it("runs a DeepSeek name as DeepSeek and a Grok name as Grok 4.7 on the Grok bridge", () => {
    cliPath = "/Users/ash/.local/bin/claude-grok";
    for (const model of ["deepseek-v4.1-flash", "claude:deepseek-v4.1-flash", "deepseek-chat", "DeepSeek"])
      expect(flag(buildClaudeSpawnArgs({ model, isolated: true }), "--model")).toBe("deepseek-v4.1-flash");
    for (const model of ["grok-4.7", "claude:grok-4.7", "grok-4", "x-ai/grok-4"])
      expect(flag(buildClaudeSpawnArgs({ model, isolated: true }), "--model")).toBe("grok-4.7");
  });

  it("runs everything as DeepSeek on the DeepSeek bridge", () => {
    cliPath = "/Users/ash/.local/bin/claude-deepseek";
    for (const model of [...CLAUDE_ALIASES, "grok-4.7", "deepseek-v4.1-flash"])
      expect(flag(buildClaudeSpawnArgs({ model, isolated: true }), "--model")).toBe("deepseek-v4.1-flash");
  });

  it("refuses, with a plain error, a model neither bridge can run, and never passes it through", async () => {
    const { BridgeModelError } = await import("../../../../features/sessions/model/bridgeModels");
    for (const path of ["/Users/ash/.local/bin/claude-grok", "/Users/ash/.local/bin/claude-deepseek"]) {
      cliPath = path;
      for (const model of ["gpt-5.6-sol", "gpt-6-astra", "gemini-4-argon", "o3", "llama-4", "mystery"]) {
        expect(() => buildClaudeSpawnArgs({ model, isolated: true })).toThrow(BridgeModelError);
        expect(() => buildClaudeSpawnArgs({ model, isolated: true })).toThrow(/can't run here.*Nothing was sent/);
      }
    }
  });

  it("a chat on a model the bridge can't run fails before any process starts", async () => {
    cliPath = "/Users/ash/.local/bin/claude-grok";
    await expect(
      sendClaudeTurn({
        sessionId: "s-unknown", cwd: "/repo", model: "gpt-5.6-sol", modelSettings: {}, runtimeMode: "supervised",
        text: "hello", attachments: [], onEvent: () => undefined,
      }),
    ).rejects.toThrow(/can't run here/);
    expect(spawned).toHaveLength(0);
  });

  it("a chat that names DeepSeek starts on DeepSeek on the Grok bridge, and isn't labelled Grok 4.7", async () => {
    cliPath = "/Users/ash/.local/bin/claude-grok";
    await oneTurn("claude:deepseek-v4.1-flash", "high");
    expect(flag(spawned[0]!.args, "--model")).toBe("deepseek-v4.1-flash");
    const { onGrokBridge } = await import("./claudeGrokBridge");
    expect(onGrokBridge("claude", "claude:deepseek-v4.1-flash")).toBe(false);
    expect(onGrokBridge("claude", "claude:grok-4.7")).toBe(true);
  });

  it("leaves the plain Claude Code alone (no bridge, no mapping)", () => {
    expect(flag(buildClaudeSpawnArgs({ model: "gpt-5.6-sol", isolated: true }), "--model")).toBe("gpt-5.6-sol");
  });
});
