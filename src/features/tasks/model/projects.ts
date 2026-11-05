// WP-70: a crew folder and the hub project it belongs to are both keys a task may be filed under.

import { pathKey } from "../../../shared/lib/paths";

export type TaskProject = { id: string; folder: string | null };

/**
 * The id a new task is filed under, and every key the list should read.
 * A matching hub project wins the write. The folder is still read, so a task filed under the path is not hidden.
 * The folder is compared, not resolved: ".." and a Windows path stay as written.
 */
export function taskProjectKeys(cwd: string, projects: readonly TaskProject[]): { write: string; read: string[] } {
  const key = pathKey(cwd);
  const hit = projects.find((project) => project.folder != null && project.folder !== "" && pathKey(project.folder) === key);
  const write = hit?.id ?? cwd;
  const read: string[] = [];
  for (const id of [write, cwd]) {
    if (id !== "" && !read.includes(id)) read.push(id);
  }
  return { write, read };
}

function addId(ids: string[], id: string) {
  if (id !== "" && !ids.includes(id)) ids.push(id);
}

/**
 * Projects whose statuses the board should ask for. A folder path is not one of them:
 * asking for it would file a second workflow under the path. All tasks asks each project once.
 */
export function statusProjectIds(scope: "all" | "project", cwd: string, projects: readonly TaskProject[]): string[] {
  if (scope === "project") {
    const write = taskProjectKeys(cwd, projects).write;
    return write === "" ? [] : [write];
  }
  const ids: string[] = [];
  for (const project of projects) addId(ids, project.id);
  addId(ids, taskProjectKeys(cwd, projects).write);
  return ids;
}
