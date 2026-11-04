// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";
import { claudeLaunchDelta, type ClaudeLaunch } from "./claudeLaunch";

/**
 * A custom model whose provider refuses the chat's reasoning level: the router retries without it (model_router.rs)
 * and announces the refusal. The chat must say so in one plain line, once, instead of quietly answering at the
 * provider's default while the picker still shows the level as picked (ed, 20 Oct: a button that looks live but
 * isn't). Driven through the live Claude adapter with a scripted Claude Code process.
 */

const sent: string[] = [];
const spawned: { args: string[]; route?: Record<string, unknown> }[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
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

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import("./claude");
const { markEffortRefused, clearRefusedEfforts } = await import("../../../../features/sessions/model/customModels");

const parse = () => sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const prompts = () => parse().filter((m) => m.type === "user").length;
const inits = () => parse().filter((m) => (m.request as { subtype?: string })?.subtype === "initialize").length;

const GROK = { id: "xai-g", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.6" };
const LINE = "xAI didn't accept the Medium level, so this reply used the provider's default.";

function emitResult() {
  emit({ type: "result", subtype: "success", session_id: "sess_1", num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
}

/** One turn on `sessionId`; `during` runs while the reply is on its way (where the router announces a refusal). */
async function turn(sessionId: string, effort: string, during?: () => void): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  const before = { prompts: prompts(), inits: inits(), spawned: spawned.length };
  const done = sendClaudeTurn({
    sessionId, cwd: "/repo", model: "custom:xai-g", modelSettings: { effort }, runtimeMode: "supervised",
    text: "carry on", attachments: [], onEvent: (event) => events.push(event),
  });
  await waitFor(() => prompts() > before.prompts || inits() > before.inits, "prompt or a new process");
  if (spawned.length > before.spawned) {
    await waitFor(() => inits() > before.inits, "initialize");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    const init = parse().filter((m) => (m.request as { subtype?: string })?.subtype === "initialize").at(-1)!;
    emit({ type: "control_response", response: { subtype: "success", request_id: init.request_id } });
    await waitFor(() => prompts() > before.prompts, "prompt");
  }
  during?.();
  emit({ type: "assistant", session_id: "sess_1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Done." }] } });
  emitResult();
  await done;
  return events;
}

const dropped = (events: HarnessEvent[]) =>
  events.filter((e): e is Extract<HarnessEvent, { type: "notice" }> => e.type === "notice" && e.key === "effort-dropped");

beforeEach(() => {
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
  localStorage.clear();
  localStorage.setItem("monocode:custom-models", JSON.stringify([GROK]));
  __claudeTestReset();
});
afterEach(async () => {
  await stopClaudeSession("chat-a");
  await stopClaudeSession("chat-b");
  __claudeTestReset();
});

describe("a reasoning level the provider refused is said in the chat", () => {
  it("shows one plain line in the turn the level was dropped, and not again in that chat", async () => {
    const first = await turn("chat-a", "medium", () => markEffortRefused({ customModelId: "xai-g", effort: "medium" }));
    expect(spawned[0].route).toMatchObject({ customModelId: "xai-g", reasoningEffort: "medium" });
    expect(dropped(first).map((e) => e.text)).toEqual([LINE]);

    // Same chat, same level: the router already leaves it out; no restart, no repeat of the line.
    const second = await turn("chat-a", "medium");
    expect(spawned).toHaveLength(1);
    expect(dropped(second)).toEqual([]);
  });

  it("a level that works says nothing, and a changed level reaches the provider (new process, said plainly)", async () => {
    const first = await turn("chat-a", "high");
    expect(dropped(first)).toEqual([]);
    const second = await turn("chat-a", "low");
    expect(spawned).toHaveLength(2);
    expect(spawned[1].route).toMatchObject({ reasoningEffort: "low" });
    expect(second).toContainEqual(expect.objectContaining({ type: "notice", text: expect.stringContaining("reasoning level change") }));
    expect(dropped(second)).toEqual([]);
  });

  it("a new chat on an already-refused level never sends it, and is told once", async () => {
    markEffortRefused({ customModelId: "xai-g", effort: "medium" });
    const events = await turn("chat-b", "medium");
    expect(spawned[0].route).toMatchObject({ customModelId: "xai-g" });
    expect(spawned[0].route).not.toHaveProperty("reasoningEffort");
    expect(dropped(events).map((e) => e.text)).toEqual([LINE]);
  });

  it("after Try again, the level is sent again and nothing is said", async () => {
    markEffortRefused({ customModelId: "xai-g", effort: "medium" });
    clearRefusedEfforts("xai-g");
    const events = await turn("chat-b", "medium");
    expect(spawned[0].route).toMatchObject({ reasoningEffort: "medium" });
    expect(dropped(events)).toEqual([]);
  });
});

describe("launch identity of a routed model", () => {
  const base: ClaudeLaunch = { route: "r", routeEffort: "medium", permissionMode: "default", allowBypass: false, thinking: false, fast: false, ultracode: false, hooks: true };
  it("a different level on the same route needs a new process, labelled as the reasoning level", () => {
    expect(claudeLaunchDelta(base, { ...base, routeEffort: "high" }).restart).toEqual(["reasoning level"]);
    expect(claudeLaunchDelta(base, { ...base }).restart).toEqual([]);
  });
});
