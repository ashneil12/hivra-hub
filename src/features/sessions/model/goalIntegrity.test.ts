// WP-247: a goal can't be closed or loosened by the run it measures.
import { describe, expect, it } from "vitest";
import {
  CAPTAIN_NEEDS_DECISION,
  GOAL_TOOL_REFUSED,
  GOAL_TURN_NOT_FROM_ASH,
  RUN_CANNOT_CHANGE_GOAL,
  goalCommandIn,
  goalToolRefusal,
  goalTurnRefusal,
  mayChangeGoalCriteria,
  reportMet,
} from "./goalIntegrity";

describe("who may change a goal's success criteria", () => {
  it("lets Ash change it", () => {
    expect(mayChangeGoalCriteria({ kind: "ash" })).toEqual({ ok: true });
  });

  it("lets the captain change it only with a decision row Ash can overturn", () => {
    expect(mayChangeGoalCriteria({ kind: "captain" })).toEqual({ ok: false, reason: CAPTAIN_NEEDS_DECISION });
    expect(mayChangeGoalCriteria({ kind: "captain", decisionId: "   " })).toEqual({ ok: false, reason: CAPTAIN_NEEDS_DECISION });
    expect(mayChangeGoalCriteria({ kind: "captain", decisionId: "goal-criteria-1" })).toEqual({ ok: true });
  });

  it("refuses the run being measured, and anything it can't read", () => {
    expect(mayChangeGoalCriteria({ kind: "run" })).toEqual({ ok: false, reason: RUN_CANNOT_CHANGE_GOAL });
    for (const odd of [null, undefined, {} as never, { kind: "worker" } as never])
      expect(mayChangeGoalCriteria(odd).ok).toBe(false);
  });
});

describe("a repeating goal", () => {
  it("stays open after its own run reports met", () => {
    const outcome = reportMet({ repeating: true }, { kind: "run" });
    expect(outcome.close).toBe(false);
    expect(outcome).toMatchObject({ reason: expect.stringContaining("stays open") });
  });

  it("closes only by Ash, or the captain with a decision row", () => {
    expect(reportMet({ repeating: true }, { kind: "ash" })).toEqual({ close: true });
    expect(reportMet({ repeating: true }, { kind: "captain", decisionId: "d1" })).toEqual({ close: true });
    expect(reportMet({ repeating: true }, { kind: "captain" }).close).toBe(false);
  });

  it("leaves a one-off goal as before: its check decides", () => {
    expect(reportMet({}, { kind: "run" })).toEqual({ close: true });
  });
});

describe("a run's attempt to edit its goal", () => {
  it("reads what a /goal line would do", () => {
    expect(goalCommandIn("/goal the tests pass")).toBe("set");
    expect(goalCommandIn("  ​/goal clear")).toBe("clear");
    expect(goalCommandIn("/GOAL Clear")).toBe("clear");
    expect(goalCommandIn("/goal")).toBe("show");
    expect(goalCommandIn("/goals")).toBeNull();
    expect(goalCommandIn("please set /goal x")).toBeNull();
    expect(goalCommandIn(42)).toBeNull();
  });

  it("refuses a turn that sets or clears the goal unless Ash typed it", () => {
    expect(goalTurnRefusal("/goal anything at all counts as done", false)).toBe(GOAL_TURN_NOT_FROM_ASH);
    expect(goalTurnRefusal("/goal clear", false)).toBe(GOAL_TURN_NOT_FROM_ASH);
    expect(goalTurnRefusal("/goal clear", true)).toBeUndefined();
    expect(goalTurnRefusal("/goal the export works in Safari", true)).toBeUndefined();
    // Showing it changes nothing; an ordinary message is untouched.
    expect(goalTurnRefusal("/goal", false)).toBeUndefined();
    expect(goalTurnRefusal("Carry on with the export", false)).toBeUndefined();
  });

  it("refuses a tool call that would run /goal, whatever tool carries it", () => {
    expect(goalToolRefusal({ tool: "SlashCommand", command: "/goal clear" })).toBe(GOAL_TOOL_REFUSED);
    expect(goalToolRefusal({ tool: "SlashCommand", command: "/goal it compiles" })).toBe(GOAL_TOOL_REFUSED);
    expect(goalToolRefusal({ tool: "SlashCommand", command: "/goal" })).toBeUndefined();
    expect(goalToolRefusal({ tool: "Bash", command: "npm test" })).toBeUndefined();
    expect(goalToolRefusal(undefined)).toBeUndefined();
  });
});
