import { afterEach, describe, expect, it } from "vitest";
import { registerCrewCancel } from "../../crew/model/cancel";
import { setAgentsBoardSessionStop, stopBoardRow } from "./sessionStop";

afterEach(() => {
  registerCrewCancel(null);
  setAgentsBoardSessionStop(null);
});

describe("stopBoardRow", () => {
  it("stops a delegation through its owner", async () => {
    const calls: { owner: string; taskId: string }[] = [];
    registerCrewCancel(async (owner, _request, input) => {
      calls.push({ owner, taskId: input.taskId });
    });
    await stopBoardRow("job", {
      delegations: [{ id: "job", ownerSession: "lead" }],
      sessions: [],
    });
    expect(calls).toEqual([{ owner: "lead", taskId: "job" }]);
  });

  it("reports a cancel failure instead of succeeding", async () => {
    registerCrewCancel(async () => {
      throw new Error("the worker is gone");
    });
    await expect(
      stopBoardRow("job", { delegations: [{ id: "job", ownerSession: "lead" }], sessions: [] }),
    ).rejects.toThrow("the worker is gone");
  });

  it("does not pretend a chat with no stop path was stopped", async () => {
    await expect(
      stopBoardRow("job", { delegations: [{ id: "job", ownerSession: "  " }], sessions: [{ id: "job" }] }),
    ).rejects.toThrow("can't be stopped");
    await expect(
      stopBoardRow("project-chat", { delegations: [], sessions: [{ id: "project-chat" }] }),
    ).rejects.toThrow("can't be stopped");
    await expect(stopBoardRow("missing", { delegations: [], sessions: [] })).rejects.toThrow("can't be stopped");
  });

  it("stops a project chat or a sub-chat through the app Stop once that is registered", async () => {
    const stopped: string[] = [];
    setAgentsBoardSessionStop(async (id) => {
      stopped.push(id);
    });
    await stopBoardRow("project-chat", { delegations: [], sessions: [{ id: "project-chat" }] });
    await stopBoardRow("sub-chat", { delegations: [], sessions: [{ id: "sub-chat" }] });
    expect(stopped).toEqual(["project-chat", "sub-chat"]);
  });

  it("does not call a stop done when the worker it names is still running", async () => {
    // tasks.cancel resolves with the chats whose Stop failed or timed out (stopTree.ts), it does not throw.
    registerCrewCancel(async () => ({ taskId: "job", status: "running", stopFailed: ["worker-chat"] }));
    await expect(
      stopBoardRow("job", { delegations: [{ id: "job", ownerSession: "lead" }], sessions: [] }),
    ).rejects.toThrow("still running");
    // The chat's own Stop on a Lead with work out is the tree stop, which says the same way.
    setAgentsBoardSessionStop(async () => ({ stopped: ["project-chat"], cancelled: [], stopFailed: ["worker-chat"] }));
    await expect(
      stopBoardRow("project-chat", { delegations: [], sessions: [{ id: "project-chat" }] }),
    ).rejects.toThrow("still running");
    setAgentsBoardSessionStop(async () => ({ stopped: ["project-chat"], cancelled: [], stopFailed: [], unloaded: ["project-chat"] }));
    await expect(
      stopBoardRow("project-chat", { delegations: [], sessions: [{ id: "project-chat" }] }),
    ).rejects.toThrow("still running");
    registerCrewCancel(async () => ({ taskId: "job", status: "cancelled", stopFailed: [] }));
    await expect(
      stopBoardRow("job", { delegations: [{ id: "job", ownerSession: "lead" }], sessions: [] }),
    ).resolves.toBeUndefined();
  });

  it("lets a session stop failure through", async () => {
    setAgentsBoardSessionStop(async () => {
      throw new Error("still running");
    });
    await expect(
      stopBoardRow("project-chat", { delegations: [], sessions: [{ id: "project-chat" }] }),
    ).rejects.toThrow("still running");
  });
});
