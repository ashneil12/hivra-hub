// @vitest-environment happy-dom
// A Lead's report on a leadership brief lands in the project's Leadership room: the Lead's report, then the briefing
// Mono's answer (its own turn on the report, the one answer), then only the seats that answer names (no review round): each other member at most
// once, NO_REPLY never posted. Posting the same report again changes nothing.
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const PROJECTS = [
  { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "gauge" as const, folder: "/p/monocode-hub" },
];

async function setup() {
  const { addMono } = await import("../../monos/model/mono");
  addMono({ id: "ada", name: "Ada", mascot: "robot", color: "gray", projects: [] });
  addMono({ id: "ed", name: "Ed", mascot: "robot", color: "gray", projects: [] });
  const leads = await import("./hubLeads");
  leads.ensureProjectLeads(PROJECTS);
  const chat = await import("./hubChats");
  const seated = chat.seatDefaultTeam("hub");
  expect(seated.memberIds).toEqual([]);
  chat.addMember(seated.id, "ada");
  chat.addMember(seated.id, "ed");
  const reports = await import("./roomReports");
  const mono = await import("../../monos/model/mono");
  const lead = mono.listMonos().find((m) => m.id === "hub-lead")!;
  expect(lead.name).toBe("Hub lead");
  return { chat, reports, lead, room: chat.leadershipChatId("hub") };
}

const report = (lead: { id: string }) => ({
  receipt: "mono-completion-app-ada-b1-g1",
  projectId: "hub",
  leadChat: "lead-chat",
  ownerMono: "ada",
  title: "Ship the room",
  report: "Shipped: the room shows reports (commit abc123, npm run check passed).",
  answer: "Good. Ash: the room is live; nothing needs you.",
});

it("posts the Lead's report and the briefing Mono's answer; only the seats the answer names look at it", async () => {
  const { chat, reports, lead, room } = await setup();
  const calls: string[] = [];
  chat.setGroupChatRunner(async (mono) => {
    calls.push(mono);
    return mono === "ed" ? "Checked: it matches Ash's words." : "NO_REPLY";
  });
  expect(await reports.postLeadReport(report(lead), { id: lead.id, name: lead.name })).toBe(true);
  await chat.roomIdle(room);
  const messages = chat.getChat(room)!.conversations[0].messages;
  expect(messages.slice(0, 2).map((m) => [m.from, m.text, m.pick?.by])).toEqual([
    [lead.id, report(lead).report, "report"],
    ["ada", report(lead).answer, "report"],
  ]);
  expect(messages[0].pick?.why).toBe("Hub lead reporting on Ada's brief for MonoCode Hub: Ship the room");
  // No review round: the answer names nobody, so nobody else is asked.
  expect(calls).toEqual([]);
  expect(messages).toHaveLength(2);
  // Again: nothing new.
  expect(await reports.postLeadReport(report(lead), { id: lead.id, name: lead.name })).toBe(false);
  expect(chat.getChat(room)!.conversations[0].messages).toHaveLength(messages.length);
});

it("no room for a briefing Mono that doesn't sit in it; an empty or NO_REPLY answer posts the report alone", async () => {
  const { chat, reports, lead, room } = await setup();
  chat.setGroupChatRunner(async () => "NO_REPLY");
  expect(await reports.postLeadReport({ ...report(lead), ownerMono: "nobody" }, { id: lead.id, name: "x" })).toBe(false);
  expect(reports.reportRoom("hub", "ada")).toBe(room);
  expect(await reports.postLeadReport({ ...report(lead), answer: "NO_REPLY" }, { id: lead.id, name: lead.name })).toBe(true);
  expect(chat.getChat(room)!.conversations[0].messages.map((m) => m.from)).toEqual([lead.id]);
});
