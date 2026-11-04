// What a panel's bridge reads (WP-33): local projects, open delegations and open decisions. Nothing here calls Ash OS.
import type { Decision } from "../../firstmate/model/steering";
import type { HubJob, HubJobGroup, HubProject, Need } from "../../hub/model/types";
import { decisionNeeds, delegationJobGroups } from "../../hub/model/localHub/decisions";
import type { Delegation } from "../../monos/model/delegations";
import type { Mono } from "../../monos/model/mono";
import { agentsData, jobsData } from "../../pages/model/pageData";
import { pageCapabilityHandlers, type PageCapabilityData } from "../../pages/model/pageCapabilities";
import type { PageSources } from "../../pages/model/pageBridgeHost";

export type LocalRecords = {
  projects: readonly HubProject[];
  delegations: readonly Delegation[];
  decisions?: readonly Decision[];
  monos?: readonly Mono[];
  userName?: string;
};

function asJob(raw: Record<string, unknown>): HubJob {
  const state = raw.state;
  return {
    id: String(raw.id ?? ""),
    projectId: String(raw.projectId ?? ""),
    title: String(raw.title ?? ""),
    lead: typeof raw.lead === "string" ? raw.lead : null,
    leadName: typeof raw.leadName === "string" ? raw.leadName : null,
    state: state === "working" || state === "checking" || state === "waiting" || state === "stuck" || state === "sent_to_lead" || state === "lead_gave_up" || state === "done" || state === "parked" ? state : "unknown",
    reason: String(raw.reason ?? ""),
    startedAt: String(raw.startedAt ?? ""),
    lastActiveAt: String(raw.lastActiveAt ?? ""),
    finishedAt: null,
    seen: false,
    ...(typeof raw.sourceRef === "string" ? { sourceRef: raw.sourceRef } : {}),
    ...(typeof raw.parentId === "string" ? { parentId: raw.parentId } : {}),
  };
}

/** Open delegations as the job groups a page already knows how to read. */
export function localJobGroups(records: LocalRecords): HubJobGroup[] {
  return delegationJobGroups(records.delegations).groups.map((group) => ({
    leadId: typeof group.leadId === "string" ? group.leadId : null,
    leadName: String(group.leadName ?? ""),
    projectId: String(group.projectId ?? ""),
    jobs: Array.isArray(group.jobs) ? group.jobs.map((job) => asJob(job)) : [],
  }));
}

function asNeed(raw: Record<string, unknown>): Need {
  return {
    id: String(raw.id ?? ""),
    projectId: String(raw.projectId ?? ""),
    title: String(raw.title ?? ""),
    why: String(raw.why ?? ""),
    actionType: "see_options",
    actionLabel: typeof raw.actionLabel === "string" ? raw.actionLabel : "See options",
    ...(typeof raw.actionTarget === "string" ? { actionTarget: raw.actionTarget } : {}),
    ...(typeof raw.since === "string" ? { since: raw.since } : {}),
  };
}

function needsOf(records: LocalRecords): Map<string, Need[]> {
  const byProject = new Map<string, Need[]>();
  for (const group of decisionNeeds(records.decisions ?? []).projects) {
    const id = String(group.projectId ?? "");
    const shown = Array.isArray(group.shown) ? group.shown : [];
    byProject.set(id, shown.map((row) => asNeed(row)));
  }
  return byProject;
}

/** The on-ask reads (`tasks`, `project`, `settings`) from local records. */
export function localCapabilityData(records: LocalRecords): PageCapabilityData {
  const groups = localJobGroups(records);
  const needs = needsOf(records);
  return {
    projects: () => [...records.projects],
    needs: (projectId) => (projectId ? needs.get(projectId) ?? [] : [...needs.values()].flat()),
    jobs: (projectId) => groups.filter((group) => group.projectId === projectId),
    waiting: () => [],
    monos: () => [],
    userName: () => records.userName,
    appearance: () => "dark",
    scheme: () => "default",
  };
}

/** The handlers a panel's bridge calls for `tasks` and `project`. */
export function localHandlers(records: LocalRecords) {
  return pageCapabilityHandlers(localCapabilityData(records));
}

/** Live `jobs` and `agents` from the same records. A quiet read subscribes to nothing: the caller passes a new board. */
export function localSources(records: LocalRecords, now = Date.now()): Pick<PageSources, "jobs.read" | "agents.read"> {
  const jobs = localJobGroups(records);
  const none = () => () => undefined;
  return {
    "jobs.read": { read: () => jobsData(jobs, records.projects), subscribe: none },
    "agents.read": {
      read: () => agentsData({
        monos: records.monos ?? [],
        session: () => undefined,
        rows: records.delegations,
        waiting: [],
        jobs,
        projects: records.projects,
        quietFor: () => undefined,
        now,
      }),
      subscribe: none,
    },
  };
}
