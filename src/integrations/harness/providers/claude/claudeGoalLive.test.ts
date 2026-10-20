import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";

// /goal through the live adapter (H5): a brief's "Done when: …" goes in as `/goal …` right behind the brief, the turn
// lasts until both are answered, the chat hears each check, MonoCode clears a goal past its cap, and a fresh
// conversation gets the goal again. The frames are Claude Code 2.1.302's own (claudeGoal.test.ts has the recordings).

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code?: number | null) => void) | undefined;
const spawned: string[][] = [];
const hooks = { on: true };

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (_id: string, _path: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void, exit: (code?: number | null) => void) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));
vi.mock("../../../../features/settings/model/settings", async (original) => ({
  ...(await original<typeof import("../../../../features/settings/model/settings")>()),
  loadClaudeHooks: () => hooks.on,
}));

const { sendClaudeTurn, stopClaudeSession, bindClaudeSession, forgetClaudeSession, __claudeTestReset } = await import("./claude");
const { GOAL_CHECK_CAP } = await import("./claudeGoal");

const parse = () => sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const prompts = () =>
  parse()
    .filter((m) => m.type === "user")
    .map((m) => ((m.message as { content: { text?: string }[] }).content ?? []).map((p) => p.text ?? "").join(""));
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const tick = () => new Promise((r) => setTimeout(r, 0));
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${label}; sent=${JSON.stringify(prompts())}`);
};

const BRIEF = "[MonoCode brief from EXO lead]\n\nFix the save bug.\n\nDone when: the save test passes";
const GOAL = "the save test passes";

const synthetic = (text: string) => ({
  type: "assistant",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  session_id: "sess_1",
});
const said = (text: string) => ({
  type: "assistant",
  message: { id: `m-${text.length}-${Math.random()}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  session_id: "sess_1",
});
const feedback = (reason: string, objective = GOAL) => ({
  type: "user",
  isSynthetic: true,
  message: { role: "user", content: [{ type: "text", text: `Stop hook feedback:\n[${objective}]: ${reason}` }] },
  parent_tool_use_id: null,
  session_id: "sess_1",
});
const result = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: text,
  session_id: "sess_1",
  ...extra,
});

type Turn = { events: HarnessEvent[]; outcome: "open" | "completed" | "failed"; done: Promise<void> };

async function start(text: string, sessionId = "worker", claudeSession = "sess_1"): Promise<Turn> {
  const before = parse().length;
  const turn: Turn = { events: [], outcome: "open", done: Promise.resolve() };
  turn.done = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "full-access",
    text,
    attachments: [],
    onEvent: (event) => turn.events.push(event),
  }).then(
    () => void (turn.outcome = "completed"),
    () => void (turn.outcome = "failed"),
  );
  await waitFor(
    () => parse().slice(before).some((m) => (m.request as { subtype?: string } | undefined)?.subtype === "initialize") || parse().slice(before).some((m) => m.type === "user"),
    "initialize or prompt",
  );
  if (!parse().slice(before).some((m) => m.type === "user")) {
    emit({ type: "system", subtype: "init", session_id: claudeSession });
    emit({ type: "control_response", response: { subtype: "success", request_id: "monocode_2" } });
  }
  await waitFor(() => parse().slice(before).some((m) => m.type === "user"), "prompt");
  await tick();
  return turn;
}
const goals = (turn: Turn) =>
  turn.events.flatMap((e) => (e.type === "goal.updated" ? [e.goal] : []));

beforeEach(async () => {
  await stopClaudeSession("worker");
  sent.length = 0;
  spawned.length = 0;
  hooks.on = true;
  __claudeTestReset();
});

describe("/goal through the live adapter", () => {
  it("sends the brief, then /goal; the turn lasts through the goal's own loop and ends when the check passes", async () => {
    const turn = await start(BRIEF);
    expect(prompts()).toEqual([BRIEF, `/goal ${GOAL}`]);
    // The brief's own answer comes first; the /goal behind it is still owed, so the turn stays open.
    emit(said("Started on the brief."));
    emit(result("Started on the brief."));
    await tick();
    expect(turn.outcome).toBe("open");
    // The /goal's turn: set, a check that says not yet, more work, a check that passes.
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit(synthetic(`Goal set: ${GOAL}`));
    emit(said("Working on it."));
    emit(feedback("the test still fails"));
    emit(said("Fixed: the save test passes."));
    emit(result("Fixed: the save test passes.", { num_turns: 2 }));
    await turn.done;
    expect(turn.outcome).toBe("completed");
    expect(goals(turn)).toEqual([
      { objective: GOAL, checks: 0, status: "active", setAt: expect.any(Number) },
      { objective: GOAL, checks: 1, status: "active", lastCheck: "the test still fails", setAt: expect.any(Number) },
      { objective: GOAL, checks: 2, status: "met", lastCheck: "the test still fails", setAt: expect.any(Number) },
    ]);
    // The CLI's "Goal set: …" is a status line, never words in the worker's reply.
    const text = turn.events.flatMap((e) => (e.type === "message.delta" ? [e.text] : [])).join("");
    expect(text).not.toContain("Goal set");
    expect(turn.events).toContainEqual({ type: "status", text: `Goal set: ${GOAL}` });
  });

  it("no /goal while Claude's hooks are off (the CLI refuses it then), or for a prompt that isn't a MonoCode brief", async () => {
    hooks.on = false;
    const turn = await start(BRIEF);
    emit(said("done"));
    emit(result("done"));
    await turn.done;
    expect(prompts()).toEqual([BRIEF]);
    hooks.on = true;
    const plain = await start("Done when: you feel like it");
    emit(said("ok"));
    emit(result("ok"));
    await plain.done;
    expect(prompts()).toEqual([BRIEF, "Done when: you feel like it"]);
  });

  it(`clears the goal after ${GOAL_CHECK_CAP} checks and waits for that too`, async () => {
    const turn = await start(BRIEF);
    emit(said("Started."));
    emit(result("Started."));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit(synthetic(`Goal set: ${GOAL}`));
    for (let i = 0; i < GOAL_CHECK_CAP; i++) {
      emit(said(`try ${i}`));
      emit(feedback(`still failing ${i}`));
    }
    await tick();
    expect(prompts().at(-1)).toBe("/goal clear");
    expect(goals(turn).at(-1)).toMatchObject({ status: "stopped", checks: GOAL_CHECK_CAP });
    // The CLI's own per-turn cap ends the goal's turn; MonoCode's clear is still owed, so the turn waits for it.
    emit({ type: "system", subtype: "informational", content: "A hook blocked the turn from ending 21 consecutive times — overriding and ending turn." });
    emit(result("", { num_turns: 22 }));
    await tick();
    expect(turn.outcome).toBe("open");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit(synthetic(`Goal cleared: ${GOAL}`));
    emit(result(`Goal cleared: ${GOAL}`, { num_turns: 0 }));
    await turn.done;
    expect(turn.outcome).toBe("completed");
    expect(goals(turn).at(-1)).toMatchObject({ status: "stopped" });
  });

  it("a fresh conversation gets the open goal again with its next turn; a resumed one keeps it", async () => {
    const first = await start(BRIEF);
    emit(said("Started."));
    emit(result("Started."));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit(synthetic(`Goal set: ${GOAL}`));
    emit(said("Working."));
    emit({ type: "system", subtype: "informational", content: "A hook blocked the turn from ending 9 consecutive times — overriding and ending turn." });
    emit(result("", { num_turns: 10 }));
    await first.done;
    expect(goals(first).at(-1)).toMatchObject({ status: "paused" });

    // Resumed (same Claude conversation): the CLI still has the goal, nothing is sent again.
    await stopClaudeSession("worker");
    bindClaudeSession("worker", "sess_1", "/repo");
    sent.length = 0;
    const resumed = await start("keep going");
    expect(spawned.at(-1)).toContain("--resume");
    expect(prompts()).toEqual(["keep going"]);
    emit(said("ok"));
    emit(feedback("still not there"));
    emit({ type: "system", subtype: "informational", content: "A hook blocked the turn from ending 9 consecutive times — overriding and ending turn." });
    emit(result("", { num_turns: 10 }));
    await resumed.done;
    expect(goals(resumed).at(-1)).toMatchObject({ status: "paused", checks: 1 });

    // A fresh conversation (a rotation forgets the old one): the goal goes in again behind the next prompt.
    await forgetClaudeSession("worker");
    const resumeless = spawned.length;
    sent.length = 0;
    const fresh = await start("Here is where we were: …", "worker", "sess_2");
    expect(spawned.length).toBe(resumeless + 1);
    expect(prompts()).toEqual(["Here is where we were: …", `/goal ${GOAL}`]);
    emit({ ...said("Read it."), session_id: "sess_2" });
    emit({ ...result("Read it."), session_id: "sess_2" });
    emit({ type: "system", subtype: "init", session_id: "sess_2" });
    emit({ ...synthetic(`Goal set: ${GOAL}`), session_id: "sess_2" });
    emit({ ...said("Done."), session_id: "sess_2" });
    emit({ ...result("Done."), session_id: "sess_2" });
    await fresh.done;
    expect(fresh.outcome).toBe("completed");
    expect(goals(fresh).at(-1)).toMatchObject({ status: "met" });
  });

  it("a turn waiting on a /goal that never starts is let go after the grace period", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const turn = await start(BRIEF);
      emit(said("Started."));
      emit(result("Started."));
      await vi.advanceTimersByTimeAsync(10);
      expect(turn.outcome).toBe("open");
      await vi.advanceTimersByTimeAsync(16_000);
      await turn.done;
      expect(turn.outcome).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Claude exiting under a held turn fails it with the exit, not a hang", async () => {
    const turn = await start(BRIEF);
    emit(said("Started."));
    emit(result("Started."));
    await tick();
    onExit!(1);
    await turn.done;
    expect(turn.outcome).toBe("failed");
  });
});
