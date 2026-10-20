import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";
import type { SessionGoal } from "../../../../features/sessions/model/session";

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
const copy = { dev: false, benchGoals: false };
vi.mock("../../../../app/model/appIdentity", async (original) => ({
  ...(await original<typeof import("../../../../app/model/appIdentity")>()),
  isDevCopy: () => copy.dev,
  // The fake-Claude bench's plan (verify_live.rs `goals`): only a dev copy under a temporary HOME ever has one.
  appIdentity: () => (copy.benchGoals ? ({ verify: { runId: "r1", goals: true } } as never) : null),
}));
vi.mock("../../../../features/settings/model/settings", async (original) => ({
  ...(await original<typeof import("../../../../features/settings/model/settings")>()),
  loadClaudeHooks: () => hooks.on,
}));

const {
  sendClaudeTurn,
  stopClaudeSession,
  cancelClaudeTurn,
  compactClaudeContext,
  bindClaudeSession,
  forgetClaudeSession,
  restoreClaudeGoal,
  dropClaudeSession,
  __claudeGoalState,
  __claudeTestReset,
} = await import("./claude");
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
  copy.dev = false;
  copy.benchGoals = false;
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
    // Each update names the conversation it was set in, so the goal saved with the chat knows where it lives.
    const at = { setAt: expect.any(Number), providerSessionId: "sess_1" };
    expect(goals(turn)).toEqual([
      { objective: GOAL, checks: 0, status: "active", ...at },
      { objective: GOAL, checks: 1, status: "active", lastCheck: "the test still fails", ...at },
      { objective: GOAL, checks: 2, status: "met", lastCheck: "the test still fails", ...at },
    ]);
    // The CLI's "Goal set: …" is a status line, never words in the worker's reply.
    const text = turn.events.flatMap((e) => (e.type === "message.delta" ? [e.text] : [])).join("");
    expect(text).not.toContain("Goal set");
    expect(turn.events).toContainEqual({ type: "status", text: `Goal set: ${GOAL}` });
  });

  it("the /goal is owed from the start: a brief answered before its own write returns doesn't end the turn", async () => {
    // hub:verify-live 20261020-153810-9bc5: on a busy window Claude's quick answer to the brief (a stdout event) ran
    // ahead of the brief's write call returning, while the /goal behind it wasn't counted yet. The turn ended under the
    // goal's loop: the worker read idle, its queued brief went in early, and a restart neither resumed it nor its goal.
    const { writeChild } = await import("../../core/child");
    const original = vi.mocked(writeChild).getMockImplementation()!;
    let returned: (() => void) | undefined;
    vi.mocked(writeChild).mockImplementation(async (id: string, line: string) => {
      await original(id, line);
      // The brief is in Claude's hands; its write call returns only when `returned` says so.
      if (line.includes("Fix the save bug.")) await new Promise<void>((resolve) => (returned = resolve));
    });
    try {
      const turn = await start(BRIEF);
      emit(said("Started on the brief."));
      emit(result("Started on the brief."));
      await tick();
      returned!();
      await waitFor(() => prompts().length === 2, "the /goal behind the brief");
      await tick();
      expect(prompts()).toEqual([BRIEF, `/goal ${GOAL}`]);
      expect(turn.outcome).toBe("open");
      emit({ type: "system", subtype: "init", session_id: "sess_1" });
      emit(synthetic(`Goal set: ${GOAL}`));
      emit(said("Working on it."));
      emit(feedback("the test still fails"));
      await tick();
      expect(turn.outcome).toBe("open");
      emit(said("Fixed: the save test passes."));
      emit(result("Fixed: the save test passes.", { num_turns: 2 }));
      await turn.done;
      expect(turn.outcome).toBe("completed");
      expect(goals(turn).at(-1)).toMatchObject({ status: "met", checks: 2 });
    } finally {
      vi.mocked(writeChild).mockImplementation(original);
    }
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

  it("a dev copy runs Claude with every hook off, so it sends no /goal; a refusal from the CLI is a status line, never the reply", async () => {
    copy.dev = true;
    const turn = await start(BRIEF);
    expect(prompts()).toEqual([BRIEF]);
    emit(synthetic("/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)."));
    emit(said("WORKER-DONE: fixed."));
    emit(result("WORKER-DONE: fixed."));
    await turn.done;
    const text = turn.events.flatMap((e) => (e.type === "message.delta" ? [e.text] : [])).join("");
    expect(text).toBe("WORKER-DONE: fixed.");
    expect(turn.events).toContainEqual(expect.objectContaining({ type: "status", text: expect.stringContaining("/goal can't run") }));
    expect(goals(turn)).toEqual([]);
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

  it(`at the cap the goal reads stopped only once \`/goal clear\` has gone in`, async () => {
    const { writeChild } = await import("../../core/child");
    let deliver!: () => void;
    const turn = await start(BRIEF);
    // The next write is MonoCode's `/goal clear`; it goes in only when `deliver` says so.
    vi.mocked(writeChild).mockImplementationOnce(
      (_id: string, line: string) =>
        new Promise<void>((resolve) => {
          sent.push(line);
          deliver = resolve;
        }),
    );
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
    expect(goals(turn).some((goal) => goal?.status === "stopped")).toBe(false);
    deliver();
    await tick();
    expect(goals(turn).at(-1)).toMatchObject({ status: "stopped", checks: GOAL_CHECK_CAP });
    emit({ type: "system", subtype: "informational", content: "A hook blocked the turn from ending 21 consecutive times — overriding and ending turn." });
    emit(result("", { num_turns: 22 }));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit(synthetic(`Goal cleared: ${GOAL}`));
    emit(result(`Goal cleared: ${GOAL}`, { num_turns: 0 }));
    await turn.done;
    expect(goals(turn).filter((goal) => goal?.status === "stopped")).toHaveLength(1);
  });

  it("at the cap, a `/goal clear` that can't be written says so, keeps the goal open and owes nothing for it", async () => {
    const { writeChild } = await import("../../core/child");
    const original = vi.mocked(writeChild).getMockImplementation()!;
    // Every `/goal clear` fails to go in (each later goal line tries again); everything else is written.
    vi.mocked(writeChild).mockImplementation(async (id: string, line: string) => {
      if (line.includes("/goal clear")) throw new Error("broken pipe");
      return original(id, line);
    });
    try {
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
      expect(turn.events).toContainEqual(
        expect.objectContaining({ type: "notice", level: "warning", text: expect.stringContaining("broken pipe") }),
      );
      expect(goals(turn).some((goal) => goal?.status === "stopped")).toBe(false);
      // The CLI's own per-turn cap ends the goal's turn; with no clear owed, the MonoCode turn ends with it.
      emit({ type: "system", subtype: "informational", content: "A hook blocked the turn from ending 21 consecutive times — overriding and ending turn." });
      await tick();
      emit(result("", { num_turns: 22 }));
      await tick();
      expect(turn.outcome).toBe("completed");
      expect(goals(turn).at(-1)).toMatchObject({ status: "paused", checks: GOAL_CHECK_CAP });
      expect(goals(turn).some((goal) => goal?.status === "stopped")).toBe(false);
    } finally {
      vi.mocked(writeChild).mockImplementation(original);
    }
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

  it("Stop, then a /compact, never marks the goal met: the CLI still enforces it, so the app keeps it", async () => {
    const turn = await start(BRIEF);
    emit(said("Started."));
    emit(result("Started."));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit(synthetic(`Goal set: ${GOAL}`));
    // Claude speaks, so its next stop would be checked; Stop cuts the turn before that, and mutes its result.
    emit(said("Working on it."));
    await cancelClaudeTurn("worker");
    emit(result("", { subtype: "error_during_execution", is_error: true, num_turns: 2 }));
    await turn.done;

    // The next /compact (manual, or the idle one before a message) ends in a zero-turn success: not a check.
    const events: HarnessEvent[] = [];
    const before = parse().length;
    const compact = compactClaudeContext({
      sessionId: "worker",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "full-access",
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => parse().slice(before).some((m) => m.type === "user"), "the /compact");
    expect(prompts().at(-1)).toBe("/compact");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit({ type: "system", subtype: "compact_boundary", session_id: "sess_1" });
    emit(result("", { num_turns: 0, stop_reason: null }));
    await compact;
    expect(events.flatMap((e) => (e.type === "goal.updated" ? [e.goal] : []))).toEqual([]);

    // Still the chat's open goal: a fresh conversation gets it again.
    await forgetClaudeSession("worker");
    const fresh = await start("Here is where we were: …", "worker", "sess_2");
    expect(prompts().slice(-2)).toEqual(["Here is where we were: …", `/goal ${GOAL}`]);
    emit({ ...result("ok"), session_id: "sess_2" });
    emit({ type: "system", subtype: "init", session_id: "sess_2" });
    emit({ ...synthetic(`Goal set: ${GOAL}`), session_id: "sess_2" });
    emit({ ...said("Done."), session_id: "sess_2" });
    emit({ ...result("Done."), session_id: "sess_2" });
    await fresh.done;
  });

  for (const how of ["Stop", "stopping the process"] as const) {
    it(`${how} leaves no stop pending: the next turn's result checks only what that turn said`, async () => {
      const turn = await start(BRIEF);
      emit(said("Started."));
      emit(result("Started."));
      emit({ type: "system", subtype: "init", session_id: "sess_1" });
      emit(synthetic(`Goal set: ${GOAL}`));
      emit(said("Working on it."));
      if (how === "Stop") await cancelClaudeTurn("worker");
      else await stopClaudeSession("worker");
      await turn.done;
      // Stopping the process: the app starts it again on the same conversation, the goal carried with its state.
      if (how !== "Stop") bindClaudeSession("worker", "sess_1", "/repo");
      const next = await start("how far did you get?");
      // A turn that ends before Claude says anything (a hook can end one) checked nothing: the cut stop never counts.
      emit({ type: "system", subtype: "init", session_id: "sess_1" });
      emit(result("", { num_turns: 1 }));
      await next.done;
      expect(goals(next).filter((goal) => goal?.status === "met")).toEqual([]);
    });
  }

  it("a brief whose conversation was gone still gets its /goal, behind the chat's brief", async () => {
    // What Claude Code 2.1.302 answers `--resume` with for a conversation it has no transcript for.
    const dead = JSON.parse(
      readFileSync(new URL("./fixtures/claude-cli-2.1.302/no-conversation-found.ndjson", import.meta.url), "utf8").trim(),
    ) as Record<string, unknown>;
    bindClaudeSession("worker", dead.session_id as string, "/repo");
    const initializes = () =>
      parse().filter((m) => (m.request as { subtype?: string } | undefined)?.subtype === "initialize").length;
    const events: HarnessEvent[] = [];
    const turn = sendClaudeTurn({
      sessionId: "worker",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "full-access",
      text: BRIEF,
      attachments: [],
      resumeFallback: (prompt) => `CHAT SO FAR\n\n${prompt}`,
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => initializes() === 1, "the first initialize");
    emit(dead);
    onExit!(1);
    await waitFor(() => initializes() === 2, "a fresh process");
    emit({ type: "control_response", response: { subtype: "success", request_id: "monocode_2" } });
    await waitFor(() => prompts().length === 2, "the brief and its /goal");
    expect(prompts()).toEqual([`CHAT SO FAR\n\n${BRIEF}`, `/goal ${GOAL}`]);
    expect(events.filter((e) => e.type === "session.providerLost")).toHaveLength(1);
    emit({ ...said("Read it."), session_id: "sess_2" });
    emit({ ...result("Read it."), session_id: "sess_2" });
    emit({ type: "system", subtype: "init", session_id: "sess_2" });
    emit({ ...synthetic(`Goal set: ${GOAL}`), session_id: "sess_2" });
    emit({ ...said("Done."), session_id: "sess_2" });
    emit({ ...result("Done."), session_id: "sess_2" });
    await turn;
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

describe("a chat's goal state over its life", () => {
  it("a rotation (forget) keeps the open goal for the fresh conversation; deleting the chat drops it", async () => {
    const turn = await start(BRIEF);
    emit(said("Started."));
    emit(result("Started."));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit(synthetic(`Goal set: ${GOAL}`));
    emit({ type: "system", subtype: "informational", content: "A hook blocked the turn from ending 9 consecutive times — overriding and ending turn." });
    emit(result("", { num_turns: 10 }));
    await turn.done;
    await forgetClaudeSession("worker");
    expect(__claudeGoalState("worker")).toEqual({ open: true, ended: false });
    dropClaudeSession("worker");
    expect(__claudeGoalState("worker")).toEqual({ open: false, ended: false });
  });

  it("deleting a chat drops the record of the goal it finished", async () => {
    const turn = await start(BRIEF);
    emit(said("Started."));
    emit(result("Started."));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit(synthetic(`Goal set: ${GOAL}`));
    emit(said("Fixed: the save test passes."));
    emit(result("Fixed: the save test passes.", { num_turns: 2 }));
    await turn.done;
    expect(goals(turn).at(-1)).toMatchObject({ status: "met" });
    await forgetClaudeSession("worker");
    expect(__claudeGoalState("worker")).toEqual({ open: false, ended: true });
    dropClaudeSession("worker");
    expect(__claudeGoalState("worker")).toEqual({ open: false, ended: false });
  });
});

describe("/goal after a restart (the goal saved with the chat)", () => {
  const saved = (patch: Partial<SessionGoal> = {}): SessionGoal => ({
    objective: GOAL,
    checks: 3,
    status: "active",
    setAt: 7,
    lastCheck: "the test still fails",
    providerSessionId: "sess_1",
    ...patch,
  });
  const CONTINUE = "Continue from where you left off.";

  it("a resumed conversation keeps it: nothing is sent again, the checks go on from the saved count, and met is final", async () => {
    restoreClaudeGoal("worker", saved());
    bindClaudeSession("worker", "sess_1", "/repo");
    const resumed = await start(CONTINUE);
    expect(spawned.at(-1)).toContain("--resume");
    expect(prompts()).toEqual([CONTINUE]);
    emit(feedback("still red"));
    emit(said("Fixed: the save test passes."));
    emit(result("Fixed: the save test passes."));
    await resumed.done;
    expect(goals(resumed)).toEqual([
      { objective: GOAL, checks: 4, status: "active", lastCheck: "still red", setAt: 7, providerSessionId: "sess_1" },
      { objective: GOAL, checks: 5, status: "met", lastCheck: "still red", setAt: 7, providerSessionId: "sess_1" },
    ]);
    // A stale copy of the saved goal (a reload before the row was written) can't bring the finished goal back.
    await forgetClaudeSession("worker");
    restoreClaudeGoal("worker", saved());
    sent.length = 0;
    const fresh = await start("next", "worker", "sess_2");
    expect(prompts()).toEqual(["next"]);
    emit({ ...said("ok"), session_id: "sess_2" });
    emit({ ...result("ok"), session_id: "sess_2" });
    await fresh.done;
    expect(goals(fresh)).toEqual([]);
  });

  it("a fresh conversation (the transcript was gone) gets the saved goal exactly once, with the checks it had", async () => {
    restoreClaudeGoal("worker", saved({ status: "paused", checks: 2 }));
    const fresh = await start("Here is where we were: …", "worker", "sess_2");
    expect(prompts()).toEqual(["Here is where we were: …", `/goal ${GOAL}`]);
    emit({ ...said("Read it."), session_id: "sess_2" });
    emit({ ...result("Read it."), session_id: "sess_2" });
    emit({ type: "system", subtype: "init", session_id: "sess_2" });
    emit({ ...synthetic(`Goal set: ${GOAL}`), session_id: "sess_2" });
    emit({ ...feedback("nearly"), session_id: "sess_2" });
    emit({ ...said("Still going."), session_id: "sess_2" });
    emit({ type: "system", subtype: "informational", content: "A hook blocked the turn from ending 9 consecutive times — overriding and ending turn." });
    emit({ ...result("", { num_turns: 10 }), session_id: "sess_2" });
    await fresh.done;
    expect(goals(fresh).at(0)).toMatchObject({ checks: 2, status: "active", setAt: 7, providerSessionId: "sess_2" });
    expect(goals(fresh).at(-1)).toMatchObject({ checks: 3, status: "paused", lastCheck: "nearly", providerSessionId: "sess_2" });
    // Its next turn in that conversation sends nothing again.
    const next = await start("keep going", "worker", "sess_2");
    expect(prompts().filter((text) => text.startsWith("/goal"))).toEqual([`/goal ${GOAL}`]);
    emit({ ...said("ok"), session_id: "sess_2" });
    emit({ ...result("ok"), session_id: "sess_2" });
    await next.done;
  });

  it("a finished goal is never restored, and a dev copy never sends a restored one; the bench's fake Claude may", async () => {
    for (const status of ["met", "cleared", "stopped"] as const) {
      __claudeTestReset();
      sent.length = 0;
      restoreClaudeGoal("worker", saved({ status }));
      const turn = await start("Here is where we were: …", "worker", `sess_${status}`);
      expect(prompts()).toEqual(["Here is where we were: …"]);
      emit({ ...result("ok"), session_id: `sess_${status}` });
      await turn.done;
      await stopClaudeSession("worker");
    }
    __claudeTestReset();
    sent.length = 0;
    copy.dev = true;
    restoreClaudeGoal("worker", saved());
    const dev = await start("Here is where we were: …", "worker", "sess_dev");
    expect(prompts()).toEqual(["Here is where we were: …"]);
    emit({ ...result("ok"), session_id: "sess_dev" });
    await dev.done;
    await stopClaudeSession("worker");
    sent.length = 0;
    copy.benchGoals = true;
    const bench = await start("Here is where we were: …", "worker", "sess_bench");
    expect(prompts()).toEqual(["Here is where we were: …", `/goal ${GOAL}`]);
    emit({ ...result("ok"), session_id: "sess_bench" });
    emit({ type: "system", subtype: "init", session_id: "sess_bench" });
    emit({ ...synthetic(`Goal set: ${GOAL}`), session_id: "sess_bench" });
    emit({ ...result(`Goal set: ${GOAL}`), session_id: "sess_bench" });
    await bench.done;
  });
});
