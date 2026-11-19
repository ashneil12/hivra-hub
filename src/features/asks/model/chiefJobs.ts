// The Chief of Staff's Working list and its count, from one place so they can never disagree. A job's status is the one
// the app computed for its row (delegations.ts `status`); it is never worked out here from the row's state.
import type { Delegation, FirstMateStatus } from "../../monos/model/delegations";

export type JobRow = Pick<Delegation, "id" | "project" | "state" | "status">;

/** The row's own status. Only a row from an older build has none; that one counts as working while it runs. */
export function jobStatus(row: Pick<Delegation, "state" | "status">): FirstMateStatus | undefined {
  return row.status ?? (row.state === "running" ? "working" : undefined);
}

/** A job still under way: working, waiting on something, or waiting on the owner. Finished and stopped jobs are not. */
export function isOpenJob(row: Pick<Delegation, "state" | "status">): boolean {
  const status = jobStatus(row);
  return status === "working" || status === "paused" || status === "needs-you";
}

export const JOB_WORD: Record<FirstMateStatus, string> = {
  working: "Working",
  paused: "Waiting",
  "needs-you": "Needs you",
  done: "Done",
  failed: "Stopped",
};

export type JobGroup<T> = { projectId: string | null; name: string; rows: T[] };

/**
 * The open jobs grouped by project, in the projects' own order. A job whose project is unknown (none on the row, or
 * one that was removed) still shows, under "No project", so the count and the list always agree.
 */
export function jobGroups<T extends JobRow>(rows: readonly T[], projects: readonly { id: string; name: string }[]): JobGroup<T>[] {
  const open = rows.filter(isOpenJob);
  const known = new Set(projects.map((project) => project.id));
  const groups: JobGroup<T>[] = projects.map((project) => ({ projectId: project.id, name: project.name, rows: open.filter((row) => row.project === project.id) }));
  const loose = open.filter((row) => !row.project || !known.has(row.project));
  if (loose.length) groups.push({ projectId: null, name: "No project", rows: loose });
  return groups.filter((group) => group.rows.length > 0);
}

/** How many jobs the Working chip and tab show: exactly the rows in the list. */
export function openJobCount(rows: readonly JobRow[]): number {
  return rows.filter(isOpenJob).length;
}
