// @vitest-environment happy-dom
// Briefs to a busy chat queue or steer instead of failing (sessions.send mode, sessions.queue), and the leadership
// team's brief to a project Lead through the delegate tool (tasks.delegate {lead}).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import type { Delegation } from "../../monos/model/delegations";
import { type AgentAppHost, type QueuedBrief } from "./agentApp";
import { handleWithBriefParts as handleAgentApp, TEST_INTENT } from "../../firstmate/testing/briefParts";
import { renderBrief } from "../../firstmate/model/brief";
import type { AgentAppTasksHost } from "./agentAppTasks";

beforeEach(() => {
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
});

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: (id: string) => id === "claude",
  hasProbedHarnessAvailability: () => true,
  probeHarnessAvailability: async () => undefined,
}));

const PROJECT = "/tmp/monocode-hub";

function host(over: Partial<AgentAppHost> = {}, mono = { id: "ada", name: "Chief of Staff" }) {
  const target: Session = { ...newSession("claude", PROJECT, "claude:opus-5-5"), id: "lead-chat", title: "MonoCode Hub lead" };
  const sent: unknown[][] = [];
  const queue: QueuedBrief[] = [];
  const base = {
    sessions: vi.fn(async () => [{ id: target.id, title: target.title, harness: "claude", model: target.model, busy: true, hasDraft: false, archived: false }]),
    session: vi.fn(async (id: string) => (id === target.id ? target : null)),
    send: vi.fn(async (...args: unknown[]) => {
      sent.push(args);
      return { alreadySubmitted: false, delivery: args[4] === "steer" ? ("steered" as const) : ("queued" as const) };
    }),
    queued: vi.fn(async (caller: string) => queue.filter((b) => b.requestId.startsWith(`app-${caller}-`))),
    unqueue: vi.fn(async (_caller: string, requestId: string) => {
      const at = queue.findIndex((b) => b.requestId === requestId);
      if (at < 0) return false;
      queue.splice(at, 1);
      return true;
    }),
    isMono: () => true,
    monoOf: () => ({ ...mono, projects: [PROJECT] }),
    ...over,
  };
  return { api: base as unknown as AgentAppHost, sent, queue, target };
}

const source: Session = { ...newSession("claude", PROJECT, "claude:opus-5-5"), id: "cos-chat" };

describe("sessions.send to a busy session", () => {
  it("queues by default and says so (with the request id to cancel by), steers when asked, never 'busy'", async () => {
    const h = host();
    const queued = await handleAgentApp(source, "b1", "sessions.send", { sessionId: "lead-chat", prompt: "Ship it", notifyOnComplete: true }, h.api);
    expect(h.sent[0]).toEqual(["lead-chat", "Ship it", "app-cos-chat-b1", "cos-chat"]);
    expect(queued).toMatchObject({ delivery: "queued", notifyOnComplete: true });
    expect((queued as { note: string }).note).toContain("sessions.queue");
    const steered = await handleAgentApp(source, "b2", "sessions.send", { sessionId: "lead-chat", prompt: "Also this", mode: "steer" }, h.api);
    expect(h.sent[1]).toEqual(["lead-chat", "Also this", "app-cos-chat-b2", undefined, "steer"]);
    expect(steered).toMatchObject({ delivery: "steered" });
    await expect(handleAgentApp(source, "b3", "sessions.send", { sessionId: "lead-chat", prompt: "x", mode: "now" }, h.api)).rejects.toThrow('mode must be "auto", "queue" or "steer"');
  });

  it("sessions.queue lists only the caller's waiting briefs and takes one back out by either form of its id", async () => {
    const h = host();
    h.queue.push(
      { sessionId: "lead-chat", title: "MonoCode Hub lead", requestId: "app-cos-chat-b1", position: 1, prompt: "Ship it" },
      { sessionId: "lead-chat", title: "MonoCode Hub lead", requestId: "app-pm-chat-b9", position: 2, prompt: "PM's" },
    );
    const listed = (await handleAgentApp(source, "q1", "sessions.queue", {}, h.api)) as { briefs: QueuedBrief[] };
    expect(listed.briefs.map((b) => b.requestId)).toEqual(["app-cos-chat-b1"]);
    expect(await handleAgentApp(source, "q2", "sessions.queue", { cancel: "b1" }, h.api)).toEqual({ cancelled: "app-cos-chat-b1" });
    // Someone else's brief can't be taken out: the caller's prefix is always applied.
    await expect(handleAgentApp(source, "q3", "sessions.queue", { cancel: "app-pm-chat-b9" }, h.api)).rejects.toThrow("No queued brief of yours");
    expect(h.queue.map((b) => b.requestId)).toEqual(["app-pm-chat-b9"]);
    expect(await handleAgentApp(source, "q4", "sessions.queue", {}, h.api)).toEqual({ briefs: [], note: "Nothing of yours is waiting in a queue." });
  });
});

describe("tasks.delegate {lead}: the leadership team briefs a project's Lead", () => {
  function leadHost(delivery: "started" | "queued" | "steered" = "queued") {
    const row = { id: "t-lead", state: "running" } as Delegation;
    const briefLead = vi.fn(async () => ({ row, childSessionId: "lead-chat", delivery, leadName: "MonoCode Hub lead" }));
    const tasks = { owned: vi.fn(async () => []), acknowledge: vi.fn(), nextChange: vi.fn(), cancel: vi.fn(), briefLead } as unknown as AgentAppTasksHost;
    return { ...host({ tasks } as Partial<AgentAppHost>), briefLead };
  }

  it("goes to the Lead's own chat as a stored task, queued behind its work unless steering is asked for", async () => {
    const h = leadHost();
    const out = await handleAgentApp(source, "b1", "tasks.delegate", { brief: "Ash: \"ship the room\"", goal: "the room shows the report", lead: "hub", asks: ["a_1"] }, h.api);
    expect(h.briefLead).toHaveBeenCalledWith(source, expect.objectContaining({ id: "ada" }), {
      lead: "hub",
      requestId: "app-cos-chat-b1",
      // Hivra WP-10: a Lead is a first mate; its brief comes from the same template, read-only on the project.
      brief: renderBrief({ intent: TEST_INTENT, spec: "Ash: \"ship the room\"" }, { kind: "first-mate" }),
      title: "Ash: \"ship the room\"",
      goal: "the room shows the report",
      askIds: ["a_1"],
      mode: "queue",
    });
    expect(out).toMatchObject({ taskId: "t-lead", childSessionId: "lead-chat", delivery: "queued", lead: "MonoCode Hub lead" });
    expect((out as { note: string }).note).toContain("Queued behind MonoCode Hub lead's current work");
    await handleAgentApp(source, "b2", "tasks.delegate", { brief: "x", lead: "hub", whenBusy: "steer" }, h.api);
    expect(h.briefLead.mock.calls[1][2]).toMatchObject({ mode: "steer" });
  });

  it("adds a standing-answers block to the Lead brief, and leaves the brief unchanged when that block is missing or fails", async () => {
    const block = "Standing answers\nThese are guidance, not permission. They do not approve a tool call, a merge, or a new action.\nS-1: Keep them? -> Keep 30 days";
    const base = renderBrief({ intent: TEST_INTENT, spec: "Ash: \"ship the room\"" }, { kind: "first-mate" });
    const standingBrief = vi.fn(async () => block);
    const row = { id: "t-lead", state: "running" } as Delegation;
    const briefLead = vi.fn(async () => ({ row, childSessionId: "lead-chat", delivery: "queued" as const, leadName: "MonoCode Hub lead" }));
    const tasks = { owned: vi.fn(async () => []), acknowledge: vi.fn(), nextChange: vi.fn(), cancel: vi.fn(), briefLead, standingBrief } as unknown as AgentAppTasksHost;
    const h = host({ tasks } as Partial<AgentAppHost>);
    await handleAgentApp(source, "b7", "tasks.delegate", { brief: "Ash: \"ship the room\"", goal: "the room shows the report", lead: "hub" }, h.api);
    expect(standingBrief).toHaveBeenCalledWith("hub");
    expect(briefLead.mock.calls[0][2].brief).toBe(`${base}\n\n${block}`);

    standingBrief.mockResolvedValueOnce("   ");
    await handleAgentApp(source, "b8", "tasks.delegate", { brief: "Ash: \"ship the room\"", goal: "the room shows the report", lead: "hub" }, h.api);
    expect(briefLead.mock.calls[1][2].brief).toBe(base);

    standingBrief.mockRejectedValueOnce(new Error("the store did not answer"));
    await handleAgentApp(source, "b9", "tasks.delegate", { brief: "Ash: \"ship the room\"", goal: "the room shows the report", lead: "hub" }, h.api);
    expect(briefLead.mock.calls[2][2].brief).toBe(base);
    expect(briefLead).toHaveBeenCalledTimes(3);
  });
  it("quotes the person's own request in a Lead's brief too (WP-171)", async () => {
    const h = leadHost();
    const asking: Session = { ...source, blocks: [{ id: "b1", role: "user", text: "Ash: ship the room, with the report in it." }] };
    await handleAgentApp(asking, "b9", "tasks.delegate", { brief: "Ship the room.", goal: "the room shows the report", lead: "hub" }, h.api);
    const sent = (h.briefLead.mock.calls[0] as unknown as [unknown, unknown, { brief: string }])[2].brief;
    expect(sent).toContain("## Original request\nContext only: your task is the Spec below.");
    expect(sent).toContain("> Ash: ship the room, with the report in it.");
    expect(sent.indexOf("## Original request")).toBeGreaterThan(sent.indexOf("## Intent"));
    expect(sent.indexOf("## Original request")).toBeLessThan(sent.indexOf("## Spec"));
  });

  it("a Lead stopped on its own question to Ash reads 'waiting on Ash: <question>', never queued behind its work", async () => {
    const question = {
      requestId: 3,
      questions: [{ id: "q", prompt: "Which sharing model should the worker build?", multiSelect: false, allowCustom: true, options: [] }],
    };
    const row = { id: "t-lead", state: "running", childSession: "lead-chat", askIds: [], updatedAt: 1, delivery: "pending" } as unknown as Delegation;
    const briefLead = vi.fn(async () => ({ row, childSessionId: "lead-chat", delivery: "queued" as const, leadName: "Tally lead" }));
    const child = vi.fn((id: string) => (id === "lead-chat" ? { busy: true, pendingQuestion: question } : undefined));
    const tasks = { owned: vi.fn(async () => [row]), acknowledge: vi.fn(), nextChange: vi.fn(), cancel: vi.fn(), briefLead, child } as unknown as AgentAppTasksHost;
    const h = host({ tasks } as Partial<AgentAppHost>);
    const out = (await handleAgentApp(source, "b6", "tasks.delegate", { brief: "fix it", lead: "tally" }, h.api)) as { note: string; leadState: string };
    expect(out.leadState).toBe("waiting on Ash: Which sharing model should the worker build?");
    expect(out.note).toContain("Tally lead is waiting on Ash: Which sharing model should the worker build?");
    expect(out.note).not.toContain("Queued behind");
    // task_status says the same while the question is open.
    const status = (await handleAgentApp(source, "s1", "tasks.status", { taskIds: ["t-lead"] }, h.api)) as { tasks: Array<{ activity: string }> };
    expect(status.tasks[0].activity).toBe("waiting on Ash: Which sharing model should the worker build?");
    // sessions.send to that chat hears it too.
    const target = { ...h.target, pendingQuestion: question };
    const h2 = host({ session: vi.fn(async (id: string) => (id === target.id ? target : null)) } as Partial<AgentAppHost>);
    const sent = (await handleAgentApp(source, "b7", "sessions.send", { sessionId: "lead-chat", prompt: "x" }, h2.api)) as { note: string; state: string };
    expect(sent.state).toBe("waiting on Ash: Which sharing model should the worker build?");
    expect(sent.note).not.toContain("Queued behind");
  });

  it("refuses a Lead brief with a worker's options, and whenBusy without a lead", async () => {
    const h = leadHost();
    await expect(handleAgentApp(source, "b3", "tasks.delegate", { brief: "x", lead: "hub", model: "sonnet" }, h.api)).rejects.toThrow("leave out model");
    await expect(handleAgentApp(source, "b4", "tasks.delegate", { brief: "x", lead: "hub", whenBusy: "later" }, h.api)).rejects.toThrow('whenBusy must be "queue" or "steer"');
    await expect(handleAgentApp(source, "b5", "tasks.delegate", { brief: "x", whenBusy: "queue" }, h.api)).rejects.toThrow("whenBusy is for a brief to a Lead");
  });
});
