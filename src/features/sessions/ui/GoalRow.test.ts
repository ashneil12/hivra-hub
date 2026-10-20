// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { newSession, type SessionGoal } from "../model/session";
import { GoalRow, goalLine } from "./GoalRow";

const render = (goal: SessionGoal) => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(createElement(GoalRow, { goal }));
  return container.textContent ?? "";
};

describe("the Goal row in a worker's chat", () => {
  it("shows the objective, the checks so far and the last check", () => {
    const text = render({ objective: "all checks pass", checks: 3, lastCheck: "lint still fails", status: "active", setAt: 1 });
    expect(text).toContain("Working toward");
    expect(text).toContain("all checks pass");
    expect(text).toContain("3 checks");
    expect(text).toContain("Last check: lint still fails");
  });

  it("says met, paused or stopped plainly, and drops the last check once met", () => {
    expect(render({ objective: "x", checks: 2, lastCheck: "no", status: "met", setAt: 1 })).not.toContain("Last check");
    expect(goalLine({ objective: "x", checks: 1, status: "met", setAt: 1 })).toEqual({ label: "Goal met", detail: "1 check" });
    expect(goalLine({ objective: "x", checks: 9, status: "paused", setAt: 1 }).label).toBe("Goal waiting for the next turn");
    expect(goalLine({ objective: "x", checks: 20, status: "stopped", setAt: 1 }).detail).toBe("20 checks, the most a goal gets");
    expect(goalLine({ objective: "x", checks: 0, status: "active", setAt: 1 }).detail).toBe("not checked yet");
  });

  it("goal.updated sets the session's goal, and null clears it", () => {
    const goal: SessionGoal = { objective: "x", checks: 0, status: "active", setAt: 1 };
    const set = applyHarnessEvent(newSession("/repo"), { type: "goal.updated", goal });
    expect(set.goal).toEqual(goal);
    expect(applyHarnessEvent(set, { type: "goal.updated", goal: null }).goal).toBeUndefined();
  });
});
