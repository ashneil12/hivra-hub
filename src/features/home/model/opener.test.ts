// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { currentHubSelection, setHubSelection } from "../../hub/model/hubNav";
import { resetHomePending, takeHomeDecision, takeHomeDoc, takeHomeTask } from "./pending";
import { SETTINGS_INDEX } from "../../settings/model/settings";
import { builderHoldLine } from "./lines";
import { applyHomeOpen, targetFor, WORKTREE_CLEANUP } from "./opener";

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
    openSettings: vi.fn(),
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

it("the held-builders line opens Settings > Worktrees > Clean up, and nothing else", () => {
  const line = builderHoldLine({
    id: "builders-disk",
    text: "New builders are waiting: 24 GB free, under the 30 GB floor",
    action: "Free up space",
    freeGb: 24,
    floorGb: 30,
  });
  expect(targetFor(line)).toEqual({ kind: "settings", section: "worktrees", anchor: "worktree-cleanup" });
  const used = hands();
  applyHomeOpen(targetFor(line), used);
  expect(used.closeChrome).toHaveBeenCalledOnce();
  expect(used.openSettings).toHaveBeenCalledExactlyOnceWith("worktrees", "worktree-cleanup");
  expect(used.openTeam).not.toHaveBeenCalled();
  expect(used.openInbox).not.toHaveBeenCalled();
  expect(used.openSession).not.toHaveBeenCalled();
  // The place it names is a real card in Settings: the anchor is the id the Settings index scrolls to.
  expect(SETTINGS_INDEX.find((entry) => entry.id === WORKTREE_CLEANUP)).toMatchObject({
    section: "worktrees",
    label: "Clean up worktrees",
  });
});

it("needs you opens the inbox and does not queue a decision", () => {
  const used = hands();
  applyHomeOpen({ kind: "needs" }, used);
  expect(used.closeChrome).toHaveBeenCalledOnce();
  expect(used.openInbox).toHaveBeenCalledOnce();
  expect(takeHomeDecision([{ key: "ship", project: "C:/work/crew" }])).toBeNull();
});

it("opens an http link and ignores every other scheme", () => {
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  const used = hands();
  applyHomeOpen({ kind: "url", href: "https://example.com/pr/1" }, used);
  applyHomeOpen({ kind: "url", href: "javascript:alert(1)" }, used);
  applyHomeOpen({ kind: "url", href: "file:///tmp/secret" }, used);
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/pr/1", "_blank", "noopener");
  expect(used.openTeam).not.toHaveBeenCalled();
  open.mockRestore();
});

it("a spend pause opens Settings > Crew on the spend limit, and does not open Clean up", () => {
  const line = builderHoldLine({
    id: "builders-spend",
    text: "Spend limit reached for hivra: $50 of $50 this month. Raise it, or wait for the month to reset.",
    action: "Raise limit",
  });
  expect(targetFor(line)).toEqual({ kind: "settings", section: "crew", anchor: "spend-limit" });
  const used = hands();
  applyHomeOpen(targetFor(line), used);
  expect(used.openSettings).toHaveBeenCalledExactlyOnceWith("crew", "spend-limit");
  expect(used.openTeam).not.toHaveBeenCalled();
  expect(SETTINGS_INDEX.find((entry) => entry.id === "spend-limit")).toMatchObject({
    section: "crew",
    label: "Spend limit",
  });
});
