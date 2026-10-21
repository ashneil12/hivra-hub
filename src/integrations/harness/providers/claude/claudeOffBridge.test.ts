// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ash (21 Oct 21:03): both things. Claude Code runs on Grok 4.7 through his subscription (the `claude-grok` bridge
 * launcher), AND new coding-team chats default to DeepSeek on High (E7). A chat with an explicit non-Grok Other model
 * leaves the bridge: the plain `claude`, Rust's own default binary check, the hub's router and DeepSeek's model id. A
 * chat with no model chosen (a Claude model) or a Grok model stays on the bridge's forced grok-4.7. No key is used or
 * seen here: the route carries only the provider, address and model id; the key stays in the Keychain (Rust).
 */

const BRIDGE = "/Users/ash/.local/bin/claude-grok";
const PLAIN = "/Users/ash/.local/bin/claude";
let cliPath: string | null = BRIDGE;
vi.mock("../../../../features/providers/model/providerBinaryPaths", () => ({
  runtimeProviderBinaryPath: (provider: string) => (provider === "claude" ? cliPath : null),
  loadProviderBinaryPath: () => cliPath,
  providerBinaryPathChangePending: () => false,
  saveProviderBinaryPath: () => true,
}));

const sent: string[] = [];
type Spawn = { path: string; args: string[]; route?: Record<string, unknown>; defaultBinary?: boolean };
const spawned: Spawn[] = [];
let onLine: ((line: string) => void) | undefined;
vi.mock("../../core/child", () => ({
  // The configured CLI (the bridge launcher) when asked with no path; this Mac's own claude when asked for the default.
  resolveClaudeBinary: async (binaryPath?: string | null) => ({ path: binaryPath === null ? PLAIN : (cliPath ?? PLAIN) }),
  spawnChild: async (
    _id: string, path: string, args: string[], _cwd: string, _account: unknown, _bp: unknown, _cs: unknown, _devin: unknown,
    route?: Record<string, unknown>, defaultBinary?: boolean,
  ) => {
    spawned.push({ path, args, route, defaultBinary });
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

const { codingTeamDefault } = await import("../../../../features/hub/model/codingTeamModel");
const { routedOffBridge, modelInUseLabel } = await import("./claudeGrokBridge");
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

async function oneTurn(sessionId: string, model: string, modelSettings: Record<string, string>) {
  sent.length = 0;
  const done = sendClaudeTurn({
    sessionId, cwd: "/repo", model, modelSettings, runtimeMode: "supervised", text: "hello", attachments: [], onEvent: () => undefined,
  });
  const initSent = () => parse().some((m) => (m.request as { subtype?: string })?.subtype === "initialize");
  await waitFor(initSent, "initialize");
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  const init = parse().filter((m) => (m.request as { subtype?: string })?.subtype === "initialize").at(-1)!;
  emit({ type: "control_response", response: { subtype: "success", request_id: init.request_id } });
  await waitFor(() => parse().some((m) => m.type === "user"), "prompt");
  emit({ type: "result", subtype: "success", session_id: "sess_1", num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  await done;
  await stopClaudeSession(sessionId);
  return spawned.at(-1)!;
}

const saveModels = (models: unknown[]) => localStorage.setItem("monocode:custom-models", JSON.stringify(models));

beforeEach(() => {
  cliPath = BRIDGE;
  saveModels([
    { id: "ds1", name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com", modelId: "deepseek-chat" },
    { id: "xg1", name: "Grok (xAI key)", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.7" },
  ]);
});
afterEach(() => {
  localStorage.clear();
  sent.length = 0;
  spawned.length = 0;
  __claudeTestReset?.();
});

describe("on the Grok bridge, a chat's explicit non-Grok model is honoured", () => {
  it("a coding-team chat on its DeepSeek default goes the DeepSeek route, off the bridge launcher", async () => {
    const choice = codingTeamDefault()!;
    expect(choice).toEqual({ harness: "claude", model: "custom:ds1", modelSettings: { effort: "high" } });
    const run = await oneTurn("coding-team", choice.model, choice.modelSettings);
    expect(run.path).toBe(PLAIN);
    expect(run.defaultBinary).toBe(true);
    expect(flag(run.args, "--model")).toBe("deepseek-chat");
    expect(run.args).not.toContain("grok-4.7");
    expect(run.route).toMatchObject({ provider: "deepseek", modelId: "deepseek-chat", customModelId: "ds1", reasoningEffort: "high" });
    // The route never carries a key.
    expect(JSON.stringify(run.route)).not.toMatch(/key/i);
    expect(modelInUseLabel("claude", "DeepSeek", choice.model)).toBe("DeepSeek");
  });

  it("a Mono chat (no model chosen: a Claude model) stays on the bridge's Grok 4.7", async () => {
    const run = await oneTurn("mono", "claude-sonnet-5", { effort: "high" });
    expect(run.path).toBe(BRIDGE);
    expect(run.defaultBinary).toBeFalsy();
    expect(flag(run.args, "--model")).toBe("grok-4.7");
    expect(run.route).toBeUndefined();
    expect(modelInUseLabel("claude", "Claude Sonnet 5", "claude-sonnet-5")).toBe("Grok 4.7");
  });

  it("a Grok model under Other models stays on the bridge too", async () => {
    expect(routedOffBridge({ model: "custom:xg1" })).toBe(false);
    const run = await oneTurn("grok-other", "custom:xg1", {});
    expect(run.path).toBe(BRIDGE);
    expect(flag(run.args, "--model")).toBe("grok-4.7");
    expect(run.route).toBeUndefined();
  });

  it("off the bridge nothing changes: DeepSeek still routes through the configured CLI", async () => {
    cliPath = null;
    const run = await oneTurn("plain", "custom:ds1", { effort: "high" });
    expect(run.defaultBinary).toBeFalsy();
    expect(flag(run.args, "--model")).toBe("deepseek-chat");
    expect(run.route).toMatchObject({ provider: "deepseek" });
  });
});
