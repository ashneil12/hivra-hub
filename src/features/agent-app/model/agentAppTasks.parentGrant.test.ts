// A session a worker starts keeps the worker's grant. sessions.start is the call that names the parent.
import { describe, expect, it, vi } from "vitest";
import { newSession } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";
import { gateSessionStart, type AgentAppTasksHost } from "./agentAppTasks";

describe("sessions.start carries the parent session into the crew gate", () => {
  it("names the session the child was started from", async () => {
    const crewGate = vi.fn(async () => undefined);
    const source = { ...newSession("claude", "/repo", "claude:opus-5-5"), id: "chat-1" };
    const tasks = {
      crewGate,
      crewRoute: vi.fn(async () => ({ cli: "claude" })),
      pool: { projectDefault: () => ({ cli: "claude" }) },
    } as unknown as AgentAppTasksHost;
    const host = { isMono: () => false, tasks } as unknown as AgentAppHost;
    await gateSessionStart(host, source, "claude", "/repo", "app-chat-1-start");
    expect(crewGate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "app-chat-1-start", parentSession: "chat-1" }),
    );
  });
});
