// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { currentHubSelection, setHubSelection } from "../../hub/model/hubNav";
import { resetHomePending, takeHomeDecision, takeHomeDoc, takeHomeTask } from "./pending";
import { applyHomeOpen, targetFor } from "./opener";

beforeEach(() => {
  localStorage.clear();
  resetHomePending();
  setHubSelection({ project: "crew", item: "home" });
});

const projects = [
  { id: "crew", folder: "C:\\work\\crew" },
  { id: "notes", folder: null },
];

function hands() {
  return {
    closeChrome: vi.fn(),
    openInbox: vi.fn(),
    openNotes: vi.fn(),
    openSession: vi.fn(),
    openTeam: vi.fn(),
    projects: () => projects,
  };
}

it("a chat line keeps its project, and opening it leaves home for that project's workspace", () => {
  expect(targetFor({ kind: "chat", projectId: "crew", target: "c1" })).toEqual({ kind: "chat", id: "c1", projectId: "crew" });
  const used = hands();
  applyHomeOpen({ kind: "chat", id: "c1", projectId: "crew" }, used);
  expect(used.closeChrome).toHaveBeenCalledOnce();
  expect(used.openTeam).not.toHaveBeenCalled();
  expect(used.openSession).toHaveBeenCalledWith("c1");
  expect(currentHubSelection()).toEqual({ project: "crew", item: "coding-team" });
});

it("a chat on a project with no folder still opens, without pretending there is a workspace", () => {
  const used = hands();
  applyHomeOpen({ kind: "chat", id: "c1", projectId: "notes" }, used);
  expect(used.openSession).toHaveBeenCalledWith("c1");
  expect(currentHubSelection()).toEqual({ project: "crew", item: "home" });
});

it("a decision is queued for the inbox, and a task or a doc is queued for its own screen", () => {
  const used = hands();
  applyHomeOpen({ kind: "inbox", projectId: "crew", decisionKey: "ship" }, used);
  expect(used.closeChrome).toHaveBeenCalledOnce();
  expect(used.openInbox).toHaveBeenCalledOnce();
  expect(takeHomeDecision([{ key: "ship", project: "C:/work/crew" }])).toBe("ship");

  applyHomeOpen({ kind: "task", projectId: "crew", id: "font" }, used);
  expect(used.openTeam).toHaveBeenCalledWith("crew");
  expect(takeHomeTask(["font"])).toBe("font");

  applyHomeOpen({ kind: "doc", id: "plan" }, used);
  expect(used.openNotes).toHaveBeenCalledOnce();
  expect(takeHomeDoc(["plan"])).toBe("plan");

  applyHomeOpen({ kind: "coding", projectId: "crew" }, used);
  expect(used.openTeam).toHaveBeenCalledWith("crew");
});
