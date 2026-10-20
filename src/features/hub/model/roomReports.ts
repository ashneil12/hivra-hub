// Where a Lead's report on a leadership brief lands besides the briefing Mono's own chat: the project's Leadership room
// (double delegation; HUB-PLAN phase 3). The report reaches the briefing Mono through the H2 report-back path as one
// turn in its chat; once that turn is over, the room gets the Lead's report and that Mono's answer (the one answer),
// then the room's usual chime-ins (hubChats.postReport).
import { findMono, monoForSession, monoLook } from "../../monos/model/mono";
import { leadFor } from "./hubLeads";
import { getChat, leadershipChatId, postReport } from "./hubChats";

export type LeadReport = {
  /** The report's receipt (mono-completion-<request>-g<n>): the room message's id, so it posts once. */
  receipt: string;
  /** The Lead's hub project id (the row's project). */
  projectId: string;
  leadChat: string;
  ownerMono: string;
  title: string;
  report: string;
  answer: string;
};

/** The Leadership room a Lead's report goes to: its project's, when the briefing Mono sits in it. */
export function reportRoom(projectId: string, ownerMono: string): string | undefined {
  const id = leadershipChatId(projectId);
  return getChat(id)?.memberIds.includes(ownerMono) ? id : undefined;
}

/** The Lead Mono whose chat this is. */
function leadMonoOf(leadChat: string): { id: string; name: string } | undefined {
  const mono = monoForSession(leadChat);
  return mono ? { id: mono.id, name: monoLook(mono).name } : undefined;
}

/** Post one Lead report to its room; false when there is no room for it or it was posted already. */
export async function postLeadReport(report: LeadReport, lead?: { id: string; name: string }): Promise<boolean> {
  const room = reportRoom(report.projectId, report.ownerMono);
  if (!room) return false;
  const who = lead ?? leadMonoOf(report.leadChat);
  if (!who) return false;
  const owner = findMono(report.ownerMono);
  const ownerName = owner ? monoLook(owner).name : report.ownerMono;
  const project = leadFor(who.id)?.projectName ?? report.projectId;
  return postReport(room, {
    id: `report-${report.receipt}`,
    from: who.id,
    text: report.report,
    answeredBy: report.ownerMono,
    answer: report.answer,
    why: `${who.name} reporting on ${ownerName}'s brief for ${project}: ${report.title}`,
  });
}
