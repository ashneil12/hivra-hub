// What waits on Ash for each project, counted once and the same wherever it shows (SPEC: "every count matches the items
// you can see"): the project card on Today and the strip badge both count the open rows Today shows for the project
// (waiting.ts: stuck rows, Needs, proposals), its chats waiting on Ash (Waiting on you), its stuck workers and its Monos
// that can't answer (the Stuck section). The baseline's Tally card said "0 needs" while Waiting on you had its question.
import { projectKey } from "../../../shared/lib/paths";
import { delegationRows, useDelegationsVersion } from "../../monos/model/delegationStore";
import { findMono, monoForSession } from "../../monos/model/mono";
import { monoFailures, useMonoFailuresVersion, type MonoFailure } from "../../monos/model/monoFailures";
import { stuckWorkers, useStuckDismissalsVersion, type StuckWorker } from "../../monos/model/workerStuck";
import { hubData } from "./hubData";
import { leadFor } from "./hubLeads";
import { waitingCount } from "./waiting";
import { useWaitingChatsVersion } from "./waitingChats";

/** The hub project a Mono works for: the project it leads, else its only project. */
export function monoProject(monoId: string | null | undefined): { id: string; name: string; shortName: string } | null {
  if (!monoId) return null;
  const projects = hubData().listProjects();
  const byLead = leadFor(monoId)?.projectId;
  const mono = findMono(monoId);
  const hit =
    projects.find((p) => p.id === byLead) ??
    (mono?.projects.length === 1 ? projects.find((p) => p.folder && projectKey(p.folder) === projectKey(mono.projects[0])) : undefined);
  return hit ? { id: hit.id, name: hit.name, shortName: hit.shortName } : null;
}

/** The hub project a stuck worker's work belongs to: its Lead's project, else the row's project or folder. */
export function stuckProject(stuck: Pick<StuckWorker, "row">): { id: string; name: string; shortName: string } | null {
  const projects = hubData().listProjects();
  const monoId = stuck.row.ownerMono ?? monoForSession(stuck.row.ownerSession)?.id;
  const byLead = monoId ? leadFor(monoId)?.projectId : undefined;
  const where = stuck.row.project ?? "";
  const hit =
    projects.find((p) => p.id === byLead) ??
    projects.find((p) => p.id === where) ??
    (where ? projects.find((p) => p.folder && projectKey(p.folder) === projectKey(where)) : undefined) ??
    (monoId && findMono(monoId)?.projects.length === 1
      ? projects.find((p) => p.folder && projectKey(p.folder) === projectKey(findMono(monoId)!.projects[0]))
      : undefined);
  return hit ? { id: hit.id, name: hit.name, shortName: hit.shortName } : null;
}

/** The Monos whose last turn failed, Today's (every one) or one project's. */
export function failedMonosFor(projectId: string | undefined): MonoFailure[] {
  const all = monoFailures();
  return projectId ? all.filter((failure) => monoProject(failure.monoId)?.id === projectId) : all;
}

/** The stuck workers Today's Stuck section lists for one project. */
export function stuckWorkersFor(projectId: string, now = Date.now()): StuckWorker[] {
  return stuckWorkers(delegationRows(), now).filter((stuck) => stuckProject(stuck)?.id === projectId);
}

/** Everything waiting on Ash for this project, as Today shows it (the card and the strip badge read this one number). */
export function attentionCount(projectId: string, now = Date.now()): number {
  return waitingCount(projectId) + stuckWorkersFor(projectId, now).length + failedMonosFor(projectId).length;
}

/** Re-render when anything the count reads changes (the Needs and proposals have their own versions at the caller). */
export function useAttentionVersion(): void {
  useWaitingChatsVersion();
  useMonoFailuresVersion();
  useDelegationsVersion();
  useStuckDismissalsVersion();
}
