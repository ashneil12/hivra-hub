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

  it("lets a session stop failure through", async () => {
    setAgentsBoardSessionStop(async () => {
      throw new Error("still running");
    });
    await expect(
      stopBoardRow("project-chat", { delegations: [], sessions: [{ id: "project-chat" }] }),
    ).rejects.toThrow("still running");
  });
});
