// @vitest-environment happy-dom
// A Lead's report on a leadership brief lands in the project's Leadership room: the Lead's report, then the briefing
// Mono's answer (its own turn on the report, the one answer), then the room's usual chime-ins: each other member at most
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
  const team = await import("./builtInMonos");
  team.ensureBuiltInMonos();
  const leads = await import("./hubLeads");
  leads.ensureProjectLeads(PROJECTS);
  const chat = await import("./hubChats");
  chat.seatDefaultTeam("hub");
  const reports = await import("./roomReports");
  const mono = await import("../../monos/model/mono");
  const lead = mono.listMonos().find((m) => m.name === "MonoCode Hub lead")!;
  return { chat, reports, lead, room: chat.leadershipChatId("hub") };
}

const report = (lead: { id: string }) => ({
  receipt: "mono-completion-app-cos-b1-g1",
  projectId: "hub",
  leadChat: "lead-chat",
  ownerMono: "chief-of-staff",
  title: "Ship the room",
  report: "Shipped: the room shows reports (commit abc123, npm run check passed).",
  answer: "Good. Ash: the room is live; nothing needs you.",
});

it("posts the Lead's report and the briefing Mono's answer, then lets the others chime in once", async () => {
  const { chat, reports, lead, room } = await setup();
  const calls: string[] = [];
  chat.setGroupChatRunner(async (mono) => {
    calls.push(mono);
    return mono === "frank" ? "Noted in memory: the room shows Lead reports." : "NO_REPLY";
  });
  // The cheap router gates who may add something (it names the answerer too, who must not speak twice).
  chat.setRoomRouter(async () => '{"chime":[{"id":"chief-of-staff","why":"x"},{"id":"frank","why":"memory"},{"id":"alfred","why":"gate"}]}');
  expect(await reports.postLeadReport(report(lead), { id: lead.id, name: "MonoCode Hub lead" })).toBe(true);
  const messages = chat.getChat(room)!.conversations[0].messages;
  expect(messages.slice(0, 2).map((m) => [m.from, m.text, m.pick?.by])).toEqual([
    [lead.id, report(lead).report, "report"],
    ["chief-of-staff", report(lead).answer, "report"],
  ]);
  expect(messages[0].pick?.why).toBe("MonoCode Hub lead reporting on Chief of Staff's brief for MonoCode Hub: Ship the room");
  // Only the other members are asked, each once; the briefing Mono doesn't answer twice; NO_REPLY stays out.
  expect(calls).toEqual(["frank", "alfred"]);
  expect(messages.slice(2).map((m) => [m.from, m.quiet, m.pick?.by])).toEqual([["frank", true, "chime"]]);
  // Again: nothing new.
  expect(await reports.postLeadReport(report(lead), { id: lead.id, name: "MonoCode Hub lead" })).toBe(false);
  expect(chat.getChat(room)!.conversations[0].messages).toHaveLength(messages.length);
});

it("no room for a briefing Mono that doesn't sit in it; an empty or NO_REPLY answer posts the report alone", async () => {
  const { chat, reports, lead, room } = await setup();
  chat.setGroupChatRunner(async () => "NO_REPLY");
  expect(await reports.postLeadReport({ ...report(lead), ownerMono: "nobody" }, { id: lead.id, name: "x" })).toBe(false);
  expect(reports.reportRoom("hub", "chief-of-staff")).toBe(room);
  expect(await reports.postLeadReport({ ...report(lead), answer: "NO_REPLY" }, { id: lead.id, name: "MonoCode Hub lead" })).toBe(true);
  expect(chat.getChat(room)!.conversations[0].messages.map((m) => m.from)).toEqual([lead.id]);
});
