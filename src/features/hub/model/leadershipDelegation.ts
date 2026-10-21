// Double delegation (HUB-PLAN phase 3; Ash 19 Oct: "the leadership team will delegate to a coding hub, and then the
// coding hub would actually do the delegation ... just report back to the leadership team"):
// a Mono -> project Lead -> workers, with the Lead's report coming back. Every Mono but a Lead works this way (Ash,
// 20 Oct: "if its stuff to fix it should either do it itself or pick it up with the coding team"), not only the
// leadership team: a project's work and its sub-chats live in that project's coding team (monoTeams.ts).
// - who a Mono may brief (`leadTargetsFor`): the Lead of each project both of them are members of. Team
//   membership is set by hubTeam.tieTeamToProjects (and by Ash, for any other Mono), so this is also the allowlist the
//   app control already enforces (a Mono only reaches sessions in its own projects);
// - the brief's shape (`LeadBrief` / `formatLeadBrief` as Chief of Staff's soul describes it, or `leadBriefPrompt` for
//   a brief written through the delegate tool);
// - one registration point (`setLeadDelegator`): the app's implementation (App.tsx) sends the brief into the Lead's own
//   long-running chat (queued behind its work, or steered into it) as a stored delegation row with the leadership Mono
//   as owner (follow "lead", monos/model/followedBriefs.ts), and the Lead's final report returns through the H2
//   report-back path to the briefing Mono's chat and its project's Leadership room (roomReports.ts). Meanwhile the
//   briefing Mono's chat shows one live line for the brief (monos/model/briefedTeams.ts), never the Lead's workers.
// The delegate tool reaches it with `delegate_task {lead}` (agent-app/model/agentAppTasks.ts).
import { MONO_HOME_FENCE } from "./hubMcp";
import { listMonos, monoWorksOn } from "../../monos/model/mono";
import { CHECKER_MONO_ID } from "./hubMcp";
import { leadFor, leadMono, leadSpecFor } from "./hubLeads";
import { isGlobalProject } from "./hubProjects";
import type { HubProject } from "./types";
import { forUser } from "./userName";

export type LeadTarget = {
  /** The Lead Mono's id (an adopted seat keeps its own id). */
  leadId: string;
  leadName: string;
  projectId: string;
  folder: string;
  /** The Lead's own long-running conversation, once it has one. */
  sessionId?: string;
};

/**
 * The Leads a Mono may brief: one per project it is a member of (by folder), whose Lead is a member of it too, never
 * the global memory. Every project's Lead counts, the four and any beyond them (one Ash made with New project).
 */
export function leadTargetsFor(monoId: string, projects: readonly HubProject[]): LeadTarget[] {
  const from = listMonos().find((m) => m.id === monoId);
  if (!from) return [];
  return projects.flatMap((project) => {
    if (isGlobalProject(project.id)) return [];
    const spec = leadSpecFor(project);
    const lead = leadMono(spec);
    if (!project.folder || !lead || lead.id === monoId || !monoWorksOn(from, project.folder)) return [];
    if (!monoWorksOn(lead, project.folder)) return [];
    return [{ leadId: lead.id, leadName: lead.name?.trim() || spec.name, projectId: spec.projectId, folder: project.folder, ...(lead.sessionId ? { sessionId: lead.sessionId } : {}) }];
  });
}

/**
 * How a Lead is named in a Mono's note: the id delegate_task takes, plus the name the room and the board use when it
 * differs ('"vg-game" (EXO lead)'), so a seat that hears "EXO lead" knows it is vg-game's Lead (AD3: PM and Alfred
 * said "there is no EXO lead" while CoS's brief to it was running).
 */
export function leadNoteName(target: Pick<LeadTarget, "projectId" | "leadName">): string {
  const name = target.leadName.trim();
  const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return !name || plain(name) === plain(`${target.projectId} lead`) || plain(name) === plain(target.projectId)
    ? `"${target.projectId}"`
    : `"${target.projectId}" (${name})`;
}

/**
 * Whether a Mono briefs project Leads: every Mono (Ash, 20 Oct: a project's work is picked up with its coding team),
 * except a Lead, which hands its own project's work to its workers, and the checker, which only reads.
 */
export function briefsLeads(monoId: string): boolean {
  const mono = listMonos().find((m) => m.id === monoId);
  return !!mono && mono.id !== CHECKER_MONO_ID && !leadFor(mono.id);
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
    ...(brief.ashWords ? [forUser`Ash's words:\n${brief.ashWords}`] : []),
    "Report: start-ack when work actually begins, then evidence when done (the commit, the check that ran, a screenshot or served URL) and what is not verified.",
  ].join("\n");
}

/** The Lead a Mono names ("hub", "MonoCode Hub", "MonoCode Hub lead", "hub-lead"), among the ones it may brief. */
export function findLeadTarget(monoId: string, projects: readonly HubProject[], named: string): LeadTarget | undefined {
  const want = named.trim().toLowerCase();
  const targets = leadTargetsFor(monoId, projects);
  return targets.find((t) => {
    const project = projects.find((p) => p.id === t.projectId);
    const names = [t.leadId, t.leadName, t.projectId, project?.name, project?.shortName, project?.name && `${project.name} lead`];
    return names.some((name) => !!name && name.toLowerCase() === want);
  });
}

/**
 * A brief written through the delegate tool, for a Lead: Ash's words and the job, what done looks like, and how a Lead
 * works it. "Done looks like" (not "Done when") on purpose: a Lead's chat is long-running and serves many briefs, so no
 * /goal is set there (its workers get one each, claudeGoal.ts).
 */
export function leadBriefPrompt(from: string, brief: string, done?: string): string {
  return [
    `[MonoCode brief from ${from}]`,
    brief.trim(),
    ...(done ? [`Done looks like: ${done.trim()}`] : []),
    `How: you are this project's Lead. Hand the work to your own workers with delegate_task (async) and review their reports. Your reply once they have all reported is what goes back to ${from}: lead with the outcome, then the evidence (the commit, the check that ran, a screenshot or served URL) and what is not verified.`,
    `Fence: ${MONO_HOME_FENCE}`,
  ].join("\n\n");
}

/** What a brief to a Lead carries when it comes through the delegate tool (the app fills in the rest). */
export type LeadDelegation = {
  fromMonoId: string;
  target: LeadTarget;
  brief: LeadBrief | string;
  /** The briefing Mono's own chat: the row's owner. */
  ownerSession?: string;
  /** The app request id (`app-<owner>-<clientRequestId>`): the row's request and the brief's id in the Lead's chat. */
  requestId?: string;
  title?: string;
  goal?: string;
  askIds?: string[];
  /** A busy Lead: queue behind its work (default) or steer into it. */
  mode?: "queue" | "steer";
};

/** The app's implementation: hand a brief to a Lead and report back to the sender. */
export type LeadDelegator = (input: LeadDelegation) => Promise<{
  taskId: string;
  childSessionId?: string;
  delivery?: "started" | "queued" | "steered";
}>;
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
/** Hand a brief to a Lead the sender may reach. Refused until the app registers a delegator, and for any other target. */
export function delegateToLead(
  fromMonoId: string,
  target: LeadTarget,
  brief: LeadBrief | string,
  projects: readonly HubProject[],
  extra: Omit<LeadDelegation, "fromMonoId" | "target" | "brief"> = {},
): ReturnType<LeadDelegator> {
  if (!delegator) return Promise.reject(new Error("Delegating to a Lead isn't connected yet."));
  if (!briefsLeads(fromMonoId))
    return Promise.reject(
      new Error(
        fromMonoId === CHECKER_MONO_ID
          ? "The checker only reads. It never briefs a Lead."
          : leadFor(fromMonoId)
            ? "A Lead hands its project's work to its own workers; it doesn't brief another Lead."
            : "That Mono isn't here.",
      ),
    );
  if (!leadTargetsFor(fromMonoId, projects).some((t) => t.leadId === target.leadId && t.projectId === target.projectId))
    return Promise.reject(new Error("That Lead isn't in one of your projects."));
  return delegator({ fromMonoId, target, brief, ...extra });
}
