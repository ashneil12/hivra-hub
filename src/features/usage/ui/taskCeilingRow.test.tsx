// @vitest-environment happy-dom
// WP-176. The open task shows its ceiling, and a stopped run's reason.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskDetail } from "../../tasks/ui/TaskDetail";
import {
  resetSpendGate,
  reviewReportedTurn,
  saveTaskCeiling,
  setSpendClock,
  setSpendSessions,
  spendSnapshot,
  taskCeilingNote,
} from "../model/spendGate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
  number: 4,
  title: "Ship the board",
  description: "",
  status: "In progress",
  needsYou: false,
  failed: false,
  assignee: null,
  comments: [],
  activity: [],
  chatId: "app-night",
};

function render(note: { line: string; held: string } | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(TaskDetail, { task, ceiling: note, onComment: () => undefined }));
  });
  return {
    text: host.textContent ?? "",
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  resetSpendGate();
  setSpendClock(() => Date.parse("2026-11-10T15:00:00"));
  setSpendSessions([]);
});

afterEach(() => {
  resetSpendGate();
});

describe("task ceiling on the row", () => {
  it("names the ceiling, and a stopped run's reason, without calling it a bill", () => {
    expect(taskCeilingNote("/work/crew", "app-night")).toBeNull();
    saveTaskCeiling("/work/crew", { hardUsd: 10, dailyUsd: 4 }, spendSnapshot().book.revision);
    expect(taskCeilingNote("/work/crew", "app-night")).toEqual({
      line: "Task ceiling $10. Unattended runs stop at $4 today.",
      held: "",
    });
    expect(taskCeilingNote("/work/other", "app-night")).toBeNull();

    const stopped = reviewReportedTurn({
      sessionId: "app-night",
      cwd: "/work/crew",
      model: "custom:paid",
      harness: "claude",
      metrics: { costUsd: 5 },
      unattended: true,
    });
    expect(stopped.stopRun).toBe(true);
    const note = taskCeilingNote("/work/crew", "app-night");
    expect(note?.held).toContain("Daily ceiling");
    expect(note?.line).not.toMatch(/your bill/i);
    expect(note?.held).not.toMatch(/[—–]/);

    const view = render(note);
    expect(view.text).toContain("Task ceiling $10.");
    expect(view.text).toContain("Needs you");
    expect(view.text).toContain(note?.held ?? "");
    view.unmount();

    const quiet = render({ line: "Task ceiling $10.", held: "" });
    expect(quiet.text).toContain("Task ceiling $10.");
    expect(quiet.text).not.toContain("Needs you");
    quiet.unmount();
  });
});
