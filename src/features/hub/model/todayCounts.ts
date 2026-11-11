// What waits on Ash for each project, counted once and the same wherever it shows (SPEC: "every count matches the items
// you can see"): the project card on Today and the strip badge both count the open rows Today shows for the project
// (waiting.ts: stuck rows, Needs, proposals), its chats waiting on Ash (Waiting on you), its stuck workers and its Monos
// that can't answer (the Stuck section). The baseline's Tally card said "0 needs" while Waiting on you had its question.
import { projectKey } from "../../../shared/lib/paths";
import { delegationRows } from "../../monos/model/delegationStore";
import { findMono, monoForSession } from "../../monos/model/mono";
import { monoFailures, type MonoFailure } from "../../monos/model/monoFailures";
import { stuckOwner, stuckWorkers, type StuckWorker } from "../../monos/model/workerStuck";
import { hubData } from "./hubData";
import { leadFor } from "./hubLeads";

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

/**
 * Whether a stuck worker counts as waiting on Ash: only a red "needs you" one. r63 (PM's blind D5 on 0.16.3): two failed
 * workers sat grey "With Hivra lead" and the Lead closed the job out, yet the badge went from 7 to 9 waiting on you. A
 * worker that is its Lead's or a retry's is never Ash's to count.
 */
export function stuckNeedsAsh(stuck: Pick<StuckWorker, "kind" | "row">): boolean {
  return stuckOwner(stuck) === "needs-you";
}

