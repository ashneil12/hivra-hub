// WP-88: a named project is one this copy already knows. A path is not trusted.

import { pathKey } from "../../../shared/lib/paths";
import { looksLikeProject } from "../../projects/model/recents";
import { inProjectScope } from "../../projects/model/projectScope";

export type CopyProject = {
  id: string;
  name: string;
  folder: string | null;
};

function badPath(path: string): boolean {
  // Both separators, on either platform. pathKey leaves a Windows climb alone on macOS.
  return path.replace(/\\/g, "/").split("/").includes("..");
}

/** Drop blanks, duplicates and paths that climb out. The first copy of an id wins. */
export function copyProjects(raw: readonly { id?: unknown; name?: unknown; folder?: unknown }[] | null | undefined): CopyProject[] {
  if (!raw) return [];
  const out: CopyProject[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item.id !== "string") continue;
    const id = item.id.trim();
    if (!id || badPath(id)) continue;
    const key = pathKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
    const folder = typeof item.folder === "string" && item.folder.trim() && !badPath(item.folder) ? item.folder.trim() : null;
    out.push({ id, name, folder });
  }
  return out;
}

/**
 * The same project, named by its id, its folder, or its one name.
 * A second project, a blank, or ".." is not the same.
 */
export function sameProject(named: string, own: string, known: readonly CopyProject[]): boolean {
  const left = named.trim();
  const right = own.trim();
  if (!left || !right || badPath(left) || badPath(right)) return false;
  if (left === right || pathKey(left) === pathKey(right)) return true;
  const a = resolveProject(left, known);
  const b = resolveProject(right, known);
  return !!a && !!b && a.id === b.id;
}

/** One project, by id, folder or a unique name. Two matches, or "..", is no match. */
export function resolveProject(named: string, known: readonly CopyProject[]): CopyProject | undefined {
  const text = named.trim();
  if (!text || badPath(text)) return undefined;
  const key = pathKey(text);
  const byId = known.filter((project) => pathKey(project.id) === key);
  if (byId.length > 1) return undefined;
  if (byId.length === 1) return byId[0];
  const byFolder = known.filter((project) => project.folder != null && pathKey(project.folder) === key);
  if (byFolder.length > 1) return undefined;
  if (byFolder.length === 1) return byFolder[0];
  const byName = known.filter((project) => project.name === text);
  return byName.length === 1 ? byName[0] : undefined;
}

/** Keys a task may be filed under. The folder is a second read, not a second project. */
export function readKeys(project: CopyProject): string[] {
  const keys = [project.id];
  if (project.folder && pathKey(project.folder) !== pathKey(project.id)) keys.push(project.folder);
  return keys;
}

/**
 * A page with no project stays visible. A named project keeps its own pages.
 * With no name, a page filed under some other folder is not this copy's.
 */
export function pageReadable(
  sourceCwd: string | null | undefined,
  named: CopyProject | undefined,
  known: readonly CopyProject[],
): boolean {
  if (named) {
    return inProjectScope(sourceCwd, named.id) || (named.folder != null && inProjectScope(sourceCwd, named.folder));
  }
  if (!sourceCwd || !looksLikeProject(sourceCwd)) return true;
  return known.some(
    (project) => pathKey(project.id) === pathKey(sourceCwd) || (project.folder != null && pathKey(project.folder) === pathKey(sourceCwd)),
  );
}
