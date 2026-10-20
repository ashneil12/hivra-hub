// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { WaitingChat } from "../../hub/model/waitingChats";
import type { HubJobGroup, HubProject } from "../../hub/model/types";
import type { Delegation } from "../../monos/model/delegations";
import type { Mono } from "../../monos/model/mono";
import type { Session } from "../../sessions/model/session";
import { agentsData, ENDED_QUIET_MS, jobsData, needsData, roomsData, STUCK_QUIET_MS, type AgentInputs } from "./pageData";

const NOW = 1_800_000_000_000;
const projects: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/p/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/p/hivra" },
];
const mono = (id: string, over: Partial<Mono> = {}): Mono => ({ id, mascot: "letter", color: "#000", projects: [], ...over });
const session = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, harness: "claude", model: "", modelSettings: {}, runtimeMode: "default", title: id, cwd: "/p", blocks: [], ...over }) as Session;
const row = (id: string, owner: string, child: string, over: Partial<Delegation> = {}): Delegation => ({
  id, ownerSession: owner, ownerMono: null, batchId: null, parentId: null, rootId: id, childSession: child, requestId: id, generation: 1,
  project: null, title: `Example: ${id}`, brief: null, goal: null, askIds: [], state: "running", errorClass: null, error: null, retryable: null,
  resetsAt: null, result: null, pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: NOW - 600_000, updatedAt: NOW - 600_000,
  settledAt: null, log: [], version: 1, mirroredVersion: 1, mirrorError: null, ...over,
});
const waitingChat = (sessionId: string, over: Partial<WaitingChat> = {}): WaitingChat => ({
  sessionId, source: "marker", question: "Example: which save layout?", more: 0, pick: "Three slots", redLine: false, cwd: "/p", title: "t",
  askedAt: NOW - 120_000, projectId: "vg-game", projectName: "EXO", chatName: "EXO lead", ...over,
});
function inputs(over: Partial<AgentInputs> & { sessions?: Session[]; quiet?: Record<string, number> } = {}): AgentInputs {
  const sessions = new Map((over.sessions ?? []).map((s) => [s.id, s]));
  return {
    monos: [], rows: [], waiting: [], jobs: [], projects, now: NOW,
    session: (id) => sessions.get(id),
    quietFor: (id) => over.quiet?.[id],
    ...over,
  };
}

it("lists every seated agent with its role, projects and chat, and what it is doing now", () => {
  const data = agentsData(inputs({
    monos: [mono("vg-game-lead", { sessionId: "s-exo" }), mono("frank", { name: "frank", projects: ["/p/hivra"] }), mono("chief-of-staff", { name: "Chief of Staff" })],
    sessions: [session("s-exo", { busy: true, blocks: [{ id: "b", role: "tool", text: "", tool: { title: "Run the movement tests" } } as never] })],
  }));
  expect(data.agents.map((a) => [a.name, a.role, a.state])).toEqual([
    ["frank", "team", "idle"], ["Chief of Staff", "team", "idle"], ["EXO lead", "lead", "working"],
  ]);
  const exo = data.agents.find((a) => a.id === "vg-game-lead")!;
  expect(exo).toMatchObject({ projects: ["vg-game"], chatId: "s-exo", doing: "Run the movement tests" });
  expect(data.agents.find((a) => a.id === "frank")!.projects).toEqual(["hivra"]);
  expect(data.counts).toMatchObject({ working: 1, idle: 2 });
});

it("an agent that asked Ash is asking, with its question, pick and the chat to answer", () => {
  const data = agentsData(inputs({ monos: [mono("vg-game-lead", { sessionId: "s-exo" })], waiting: [waitingChat("s-exo")] }));
  expect(data.agents[0]).toMatchObject({ state: "asking", question: { chatId: "s-exo", text: "Example: which save layout?", pick: "Three slots", canAnswer: true }, since: NOW - 120_000 });
});

it("handed-out work nests under the agent that started it, with working, asking, stuck, failed, done and stopped", () => {
  const rows = [
    row("d1", "s-exo", "w1"),
    row("d2", "s-exo", "w2", { state: "question", pendingQuestion: "Example: keep the old saves?" }),
    row("d3", "s-exo", "w3"),
    row("d4", "s-exo", "w4", { state: "failed", error: "Example: the build broke" }),
    row("d5", "s-exo", "w5", { state: "completed", settledAt: NOW - 60_000 }),
    row("d6", "s-exo", "w6", { state: "cancelled" }),
    row("d7", "w1", "w7"),
  ];
  const data = agentsData(inputs({
    monos: [mono("vg-game-lead", { sessionId: "s-exo" })], rows,
    sessions: [session("w1", { busy: true }), session("w3", { busy: true }), session("w7", { busy: false })],
    quiet: { w1: 1000, w3: STUCK_QUIET_MS + 60_000, w7: ENDED_QUIET_MS + 1 },
  }));
  const exo = data.agents[0];
  expect(exo.workers.map((w) => [w.id, w.state])).toEqual([["d1", "working"], ["d2", "asking"], ["d3", "stuck"], ["d4", "failed"], ["d5", "done"], ["d6", "stopped"]]);
  expect(exo.workers[1].question).toMatchObject({ chatId: "w2", text: "Example: keep the old saves?", canAnswer: false });
  expect(exo.workers[2].reason).toBe("No progress for 11 min.");
  expect(exo.workers[3].reason).toBe("Example: the build broke");
  expect(exo.workers[0].workers.map((w) => [w.id, w.state, w.reason])).toEqual([["d7", "stuck", "Its chat stopped without reporting back."]]);
  expect(exo.waitingOn).toBe(3);
  // The Lead itself is idle in its chat but its workers are at it.
  expect(exo).toMatchObject({ state: "working", doing: "Waiting on 3 workers" });
});

it("a worker asking its Lead with a live question can be answered from the page (its chat)", () => {
  const prompt = { requestId: 4, questions: [{ id: "q", prompt: "Example: which slot?", multiSelect: false, allowCustom: true, options: [{ id: "a", label: "Slot 2 (Recommended)" }, { id: "b", label: "Slot 3" }] }] };
  const data = agentsData(inputs({ monos: [mono("vg-game-lead", { sessionId: "s-exo" })], rows: [row("d1", "s-exo", "w1", { state: "question" })], sessions: [session("w1", { busy: true, pendingQuestion: prompt })] }));
  expect(data.agents[0].workers[0].question).toEqual({ chatId: "w1", text: "Example: which slot?", options: ["Slot 2 (Recommended)", "Slot 3"], pick: "Slot 2", redLine: false, canAnswer: true });
});

it("a stuck Being built job makes its Lead stuck, with the job and the reason", () => {
  const jobs: HubJobGroup[] = [{ leadId: "hivra-lead", leadName: "Hivra lead", projectId: "hivra", jobs: [
    { id: "j1", projectId: "hivra", title: "Example: send the welcome emails", lead: "hivra-lead", leadName: "Hivra lead", state: "stuck", reason: "Example: the sender refused the login",
      startedAt: new Date(NOW - 3_600_000).toISOString(), lastActiveAt: new Date(NOW - 900_000).toISOString(), finishedAt: null, seen: false },
  ] }];
  const data = agentsData(inputs({ monos: [mono("hivra-lead")], jobs }));
  expect(data.agents[0]).toMatchObject({ state: "stuck", reason: "Example: send the welcome emails: Example: the sender refused the login", since: NOW - 900_000 });
  expect(jobsData(jobs, projects).jobs[0]).toMatchObject({ projectName: "Hivra", agentName: "Hivra lead", state: "stuck" });
});

it("needs and waiting chats, and rooms' latest messages, in plain shapes", () => {
  const n = needsData(
    [{ id: "q:7", projectId: "hivra", title: "Example: pick a headline", why: "Two tested the same.", actionType: "see_options", actionLabel: "See options", state: "open" },
      { id: "x", projectId: "hivra", title: "done one", why: "", actionType: "open", actionLabel: "Open", state: "done" }],
    [waitingChat("s-exo")], projects);
  expect(n.needs).toEqual([{ id: "q:7", projectId: "hivra", projectName: "Hivra", title: "Example: pick a headline", why: "Two tested the same.", action: "See options", isQuestion: true }]);
  expect(n.waiting[0]).toMatchObject({ chatId: "s-exo", chatName: "EXO lead", pick: "Three slots" });
  const r = roomsData([{ id: "hivra:leadership", projectId: "hivra", name: "Leadership", isDefault: true, memberIds: ["frank"], conversations: [
    { id: "c1", when: "Today", title: "t", messages: [{ id: "m1", from: "ash", text: "hi" }, { id: "m2", from: "frank", text: "Example: on it" }] }] }], (id) => id.toUpperCase(), { limit: 1 });
  expect(r.rooms[0].conversation?.messages).toEqual([{ id: "m2", from: "FRANK", text: "Example: on it" }]);
});
