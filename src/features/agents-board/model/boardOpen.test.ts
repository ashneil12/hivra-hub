// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { currentHubSelection, setHubSelection } from "../../hub/model/hubNav";
import { setHomeOpener } from "../../home/model/opener";
import { boardOpenTarget, openBoardRow } from "./boardOpen";

let off: (() => void) | undefined;
afterEach(() => off?.());

it("opens the row's own chat", () => {
  const opened: unknown[] = [];
  off = setHomeOpener((target) => opened.push(target));
  openBoardRow({ id: "job", role: "worker", sessionId: "chat", projectId: "hivra" });
  expect(opened).toEqual([{ kind: "chat", id: "chat", projectId: "hivra" }]);
});

it("opens the Lead's chat to answer a worker that has its own chat", () => {
  const opened: unknown[] = [];
  off = setHomeOpener((target) => opened.push(target));
  openBoardRow({ id: "job", role: "worker", sessionId: "worker-chat", projectId: "hivra" }, "lead-chat");
  expect(opened).toEqual([{ kind: "chat", id: "lead-chat", projectId: "hivra" }]);
});

it("opens the owner's chat when the needs-you row has none of its own", () => {
  const opened: unknown[] = [];
  off = setHomeOpener((target) => opened.push(target));
  openBoardRow({ id: "job", role: "worker", sessionId: null, projectId: "hivra" }, "owner-chat");
  expect(opened).toEqual([{ kind: "chat", id: "owner-chat", projectId: "hivra" }]);
});

it("opens the project when a needs-you row has no chat to answer in", () => {
  setHubSelection({ project: "notes", item: "agents" });
  expect(boardOpenTarget({ id: "job", role: "worker", sessionId: "  ", projectId: "hivra" })).toEqual({
    kind: "needs-you",
    id: "job",
    projectId: "hivra",
  });
  openBoardRow({ id: "job", role: "worker", sessionId: null, projectId: "hivra" });
  expect(currentHubSelection()).toEqual({ project: "hivra", item: "coding-team" });
});

it("opens a project chat or a sub-chat by its own id", () => {
  const opened: unknown[] = [];
  off = setHomeOpener((target) => opened.push(target));
  openBoardRow({ id: "project-chat", role: "project", sessionId: null, projectId: "hivra" });
  openBoardRow({ id: "sub-chat", role: "subchat", sessionId: "sub-chat", projectId: "hivra" });
  expect(opened).toEqual([
    { kind: "chat", id: "project-chat", projectId: "hivra" },
    { kind: "chat", id: "sub-chat", projectId: "hivra" },
  ]);
});

it("does nothing when there is nowhere to open", () => {
  const opened: unknown[] = [];
  off = setHomeOpener((target) => opened.push(target));
  expect(boardOpenTarget({ id: "  ", role: "worker", sessionId: null, projectId: null })).toBeNull();
  openBoardRow({ id: "job", role: "worker", sessionId: null, projectId: null });
  expect(opened).toEqual([]);
});
