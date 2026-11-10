import { describe, expect, it, vi } from "vitest";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import type { AgentAppTasksHost } from "../../agent-app/model/agentAppTasks";
import { handleWithBriefParts } from "../../firstmate/testing/briefParts";
import { newSession, type Session } from "../../sessions/model/session";

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: () => true,
  hasProbedHarnessAvailability: () => true,
  probeHarnessAvailability: async () => undefined,
}));

const PROJECT = "/tmp/fresh-eyes-project";

describe("fresh-eyes before a builder starts", () => {
  it("does not start a builder while the review is waiting", async () => {
    const source: Session = { ...newSession("claude", PROJECT), id: "mono-lead" };
    const start = vi.fn(async () => undefined);
    const tasks = {
      owned: vi.fn(async () => []),
      acknowledge: vi.fn(async () => undefined),
      nextChange: vi.fn(async () => undefined),
      cancel: vi.fn(async () => ({ stopFailed: [] })),
      freshEyes: vi.fn(async () => ({ hold: true, why: "Fresh-eyes review: 2 findings, waiting on you" })),
    } as unknown as AgentAppTasksHost;
    const host = {
      start,
      sessions: vi.fn(async () => []),
      session: vi.fn(async () => null),
      send: vi.fn(async () => ({ alreadySubmitted: false })),
      draft: vi.fn(async () => ({ alreadySaved: false, draft: true })),
      stop: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      worktrees: vi.fn(async () => ({ worktrees: [], defaultRoot: "/tmp/w" })),
      createWorktree: vi.fn(),
      notes: vi.fn(async () => []),
      note: vi.fn(async () => null),
      saveNote: vi.fn(),
      isMono: () => true,
      monoOf: () => ({ id: "lead", name: "Lead", projects: [PROJECT] }),
      tasks,
    } as unknown as AgentAppHost;

    const result = await handleWithBriefParts(
      source,
      "r1",
      "tasks.delegate",
      { brief: "Fix the save bug." },
      host,
    );

    expect(start).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      freshEyes: true,
      note: "Fresh-eyes review: 2 findings, waiting on you",
      childSessionId: "fresh-eyes-r1",
    });
  });
});
