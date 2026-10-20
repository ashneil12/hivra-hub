import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GOAL_MAX,
  goalCommand,
  goalFromBrief,
  goalOpen,
  goalView,
  nextGoal,
  type GoalTrack,
} from "./claudeGoal";

// What Claude Code 2.1.302 printed for /goal in stream-json mode, run the way MonoCode runs it (real CLI, a fake model
// API, no login). "probe" lines are what the probe wrote in; the rest is the CLI's own output, paths shortened.
const FIXTURES = new URL("./fixtures/claude-cli-2.1.302/", import.meta.url);
function frames(name: string): Record<string, unknown>[] {
  return readFileSync(new URL(name, FIXTURES), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((rec) => !("probe" in rec));
}

/** Every goal the chat would be shown, in order, while the frames go by. */
function follow(name: string, start: GoalTrack | null = null) {
  let goal = start;
  const shown: ReturnType<typeof goalView>[] = [];
  for (const rec of frames(name)) {
    const next = nextGoal(goal, rec, 1_000);
    if (next === undefined) continue;
    goal = next;
    shown.push(goalView(goal));
  }
  return { goal, shown };
}

describe("goalFromBrief", () => {
  it("reads a MonoCode brief's finish line, and nothing else's", () => {
    const brief = "[MonoCode brief from EXO lead]\n\nFix the save bug.\n\nDone when: the save test passes\nand CI is green";
    expect(goalFromBrief(brief)).toBe("the save test passes and CI is green");
    expect(goalFromBrief("Fix it.\n\nDone when: never")).toBeUndefined();
    expect(goalFromBrief("[MonoCode brief from EXO lead]\n\nNo finish line here.")).toBeUndefined();
    expect(goalFromBrief("[MonoCode brief from x]\n\nb\n\nDone when: " + "y".repeat(2_000))).toHaveLength(GOAL_MAX);
    expect(goalCommand("  all   checks\npass ")).toBe("/goal all checks pass");
  });

  it("stops at the project memory a Lead's worker gets after the finish line (agentAppTasks.briefPrompt)", () => {
    const memory =
      "<project_memory>\nAsh OS loaded this at the start of this conversation: what holds now for Verify.\n\n- Never ship work another session made [19 Oct]\n</project_memory>";
    const brief = `[MonoCode brief from Verify lead]\n\nBuild the API.\n\nDone when: the API test passes\nin CI\n\n${memory}`;
    expect(goalFromBrief(brief)).toBe("the API test passes in CI");
    // A brief that quotes the tag itself keeps its finish line: only the trailing block is the primer.
    const quoting = `[MonoCode brief from Verify lead]\n\n<project_memory> blocks: explain them in the docs.\n\nDone when: the docs say it\n\n${memory}`;
    expect(goalFromBrief(quoting)).toBe("the docs say it");
  });
});

describe("nextGoal over Claude Code 2.1.302's own output", () => {
  it("set, one check that says not yet, then met (goal-set-checked-met)", () => {
    const { goal, shown } = follow("goal-set-checked-met.ndjson");
    expect(shown[0]).toEqual({ objective: "the transcript says GOAL-DONE (GOAL-PROBE)", checks: 0, status: "active", setAt: 1_000 });
    expect(shown).toContainEqual(
      expect.objectContaining({ checks: 1, status: "active", lastCheck: "no GOAL-DONE in the transcript yet" }),
    );
    expect(goal).toMatchObject({ checks: 2, status: "met" });
    expect(goalOpen(goal)).toBe(false);
  });

  it("a brief's turn ends without a goal; the /goal behind it loops until met (goal-after-brief)", () => {
    const { goal, shown } = follow("goal-after-brief.ndjson");
    // Nothing is shown for the brief's own turn: no goal yet.
    expect(shown[0]).toMatchObject({ checks: 0, status: "active" });
    expect(goal).toMatchObject({ status: "met", lastCheck: "no GOAL-DONE in the transcript yet" });
  });

  it("the CLI's own per-turn cap pauses the goal; `/goal` reports it still active (goal-block-cap-status)", () => {
    const { goal, shown } = follow("goal-block-cap-status.ndjson");
    expect(shown.some((g) => g?.status === "paused" && g.checks === 9)).toBe(true);
    // The status line ("Goal active: … (9 turns)") brings it back to active with the CLI's count.
    expect(goal).toMatchObject({ objective: "some condition that stays unmet", checks: 9, status: "active" });
  });

  it("--resume keeps the goal (goal-survives-resume)", () => {
    const { goal } = follow("goal-survives-resume.ndjson");
    expect(goal).toMatchObject({ objective: "the transcript says NEVER-SAID", status: "active" });
    // "not yet evaluated" after the resume doesn't lose the checks already counted.
    expect(goal!.checks).toBe(9);
  });

  it("clears, and a cleared goal that MonoCode capped reads stopped", () => {
    const cleared = { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "Goal cleared: x" }] } };
    const current: GoalTrack = { objective: "x", checks: 3, status: "active", setAt: 1 };
    expect(nextGoal(current, cleared, 2)).toMatchObject({ status: "cleared" });
    expect(nextGoal({ ...current, clearing: true, status: "stopped" }, cleared, 2)).toMatchObject({ status: "stopped" });
    expect(nextGoal(null, cleared, 2)).toBeNull();
  });

  it("feedback for another Stop hook, a failed turn, or a subagent's line is not a goal check", () => {
    const current: GoalTrack = { objective: "x", checks: 1, status: "active", setAt: 1, pendingCheck: true };
    const other = { type: "user", isSynthetic: true, message: { content: [{ type: "text", text: "Stop hook feedback:\n[lint]: fix it" }] } };
    expect(nextGoal(current, other, 2)).toBeUndefined();
    const failed = { type: "result", subtype: "error_during_execution", is_error: true };
    expect(nextGoal(current, failed, 2)).toMatchObject({ status: "active", checks: 1, pendingCheck: false });
  });

  it("a zero-turn result (a /compact, `/goal`, `/goal clear`) is never a check, even with a stop still pending", () => {
    // Claude spoke, then Stop muted the interrupted result: the stop that never reached the evaluator is still pending.
    const current: GoalTrack = { objective: "x", checks: 1, status: "active", setAt: 1, pendingCheck: true };
    // What a /compact ends with (T3 Code's recording of the CLI, claude_compact_after_peer_turn).
    const compacted = readFileSync(new URL("../t3code/claude_compact_after_peer_turn.ndjson", FIXTURES), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { frame?: Record<string, unknown> }).frame)
      .filter((frame): frame is Record<string, unknown> => frame?.type === "result")
      .at(-1)!;
    expect(compacted).toMatchObject({ subtype: "success", is_error: false, num_turns: 0 });
    expect(nextGoal(current, compacted, 2)).toBeUndefined();
    // `/goal` with no argument answers the same way (goal-block-cap-status).
    const status = frames("goal-block-cap-status.ndjson").filter((rec) => rec.type === "result").at(-1)!;
    expect(status).toMatchObject({ subtype: "success", num_turns: 0 });
    expect(nextGoal(current, status, 2)).toBeUndefined();
    // A turn Claude ran is still checked.
    expect(nextGoal(current, { ...compacted, num_turns: 1 }, 2)).toMatchObject({ status: "met", checks: 2 });
  });
});
