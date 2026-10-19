// The seam for double delegation (HUB-PLAN phase 3: leadership team -> project Lead -> subagents, with reports back).
// Not built here: it needs the delegate tool (PHASE-2-DESIGN H3, `delegate_task` on MonoCode's app control). What this
// branch provides, and H3 plugs into:
// - who a leadership Mono may hand work to (`leadTargetsFor`): the Leads of the projects it is a member of. Team
//   membership is set by hubTeam.tieTeamToProjects, so this is also the allowlist the app control already enforces
//   (a Mono only reaches sessions in its own projects);
// - the brief's shape (`LeadBrief` / `formatLeadBrief`), as Chief of Staff's soul describes it, so a brief sent by
//   `delegate_task` reads the same as one written by hand;
// - one registration point (`setLeadDelegator`) for H3's implementation, and `leadDelegationReady` for callers.
// Until H3 lands, a team Mono reaches a Lead the way any Mono reaches a project session (app sessions.send with
// notifyOnComplete, refused while the Lead is busy); queuing briefs to a busy Lead is H3's job.
import { listMonos, monoWorksOn } from "../../monos/model/mono";
import { isDefaultTeamMono } from "./builtInMonos";
import { LEADS, leadMono } from "./hubLeads";
import { isGlobalProject } from "./hubProjects";
import type { HubProject } from "./types";

export type LeadTarget = {
  /** The Lead Mono's id (an adopted seat keeps its own id). */
  leadId: string;
  leadName: string;
  projectId: string;
  folder: string;
  /** The Lead's own long-running conversation, once it has one. */
  sessionId?: string;
};

/** The Leads a Mono may brief: one per project it is a member of (by folder), never the global memory. */
export function leadTargetsFor(monoId: string, projects: readonly HubProject[]): LeadTarget[] {
  const from = listMonos().find((m) => m.id === monoId);
  if (!from) return [];
  return LEADS.flatMap((spec) => {
    if (isGlobalProject(spec.projectId)) return [];
    const project = projects.find((p) => p.id === spec.projectId);
    const lead = leadMono(spec);
    if (!project?.folder || !lead || lead.id === monoId || !monoWorksOn(from, project.folder)) return [];
    return [{ leadId: lead.id, leadName: lead.name?.trim() || spec.name, projectId: spec.projectId, folder: project.folder, ...(lead.sessionId ? { sessionId: lead.sessionId } : {}) }];
  });
}

/** Whether a Mono is one of the leadership team, which briefs Leads (the Leads themselves brief only workers). */
export function briefsLeads(monoId: string): boolean {
  const mono = listMonos().find((m) => m.id === monoId);
  return !!mono && isDefaultTeamMono(mono);
}

/** A brief from the leadership team to a Lead (Chief of Staff's soul, "How I hand work to a project Lead"). */
export type LeadBrief = {
  outcome: string;
  done: string;
  alreadyFinished?: string;
  fence?: string;
  /** Ash's own words the brief comes from, passed whole. */
  ashWords?: string;
};

export function formatLeadBrief(from: string, brief: LeadBrief): string {
  return [
    `[MonoCode brief from ${from}]`,
    `Outcome: ${brief.outcome}`,
    `Done looks like: ${brief.done}`,
    ...(brief.alreadyFinished ? [`Already finished: ${brief.alreadyFinished}`] : []),
    ...(brief.fence ? [`Fence: ${brief.fence}`] : []),
    ...(brief.ashWords ? [`Ash's words:\n${brief.ashWords}`] : []),
    "Report: start-ack when work actually begins, then evidence when done (the commit, the check that ran, a screenshot or served URL) and what is not verified.",
  ].join("\n");
}

/** H3's implementation: hand a brief to a Lead and report back to the sender. */
export type LeadDelegator = (input: { fromMonoId: string; target: LeadTarget; brief: LeadBrief }) => Promise<{ taskId: string }>;
let delegator: LeadDelegator | undefined;
export function setLeadDelegator(next: LeadDelegator): () => void {
  delegator = next;
  return () => {
    if (delegator === next) delegator = undefined;
  };
}
export function leadDelegationReady(): boolean {
  return !!delegator;
}
/** Hand a brief to a Lead the sender may reach. Refused until H3 registers a delegator, and for any other target. */
export function delegateToLead(fromMonoId: string, target: LeadTarget, brief: LeadBrief, projects: readonly HubProject[]): Promise<{ taskId: string }> {
  if (!delegator) return Promise.reject(new Error("Delegating to a Lead isn't connected yet."));
  if (!leadTargetsFor(fromMonoId, projects).some((t) => t.leadId === target.leadId && t.projectId === target.projectId))
    return Promise.reject(new Error("That Lead isn't in one of your projects."));
  return delegator({ fromMonoId, target, brief });
}
