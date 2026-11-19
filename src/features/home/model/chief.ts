// Which Mono is the Chief of Staff. By the every-project flag first, so a rename still counts.
// The name is only a fallback for a roster that never got the flag. The template id is not special.

import { hubMonoRank } from "../../hub/model/hubData";
import { addStarterMono } from "../../hub/model/starterMonos";
import { openMonoChat } from "../../hub/model/hubNav";
import { readsEveryProject, type ScopeMono } from "../../chief/model/scope";
import type { Mono } from "../../monos/model/mono";

export type ChiefCandidate = {
  id: string;
  name?: string;
  everyProject?: boolean;
};

const NAMES = new Set(["chief of staff", "coordinator"]);

function named(mono: ChiefCandidate): boolean {
  return NAMES.has((mono.name ?? "").trim().toLowerCase());
}

/** The top slot. Several matches: the hub's own rank, then the order they were given. */
export function pickChief<T extends ChiefCandidate>(monos: readonly T[]): T | undefined {
  const scoped = monos.filter((mono) => mono.everyProject === true);
  const pool = scoped.length > 0 ? scoped : monos.filter(named);
  if (pool.length === 0) return undefined;
  return pool.reduce((best, mono) => {
    const rank = hubMonoRank(mono);
    const bestRank = hubMonoRank(best);
    if (rank !== bestRank) return rank < bestRank ? mono : best;
    return monos.indexOf(mono) < monos.indexOf(best) ? mono : best;
  });
}

/** The line under the name. Only when WP-88's scope is actually on. */
export function chiefScopeLine(mono: ScopeMono | null | undefined, projectCount: number): string | undefined {
  if (!readsEveryProject(mono)) return undefined;
  if (!Number.isFinite(projectCount) || projectCount < 0) return undefined;
  const count = Math.floor(projectCount);
  return `read all ${count} ${count === 1 ? "project" : "projects"}`;
}

/** The starter template, with the scope the template already asks for. Nothing is filed. */
export function addChiefOfStaff(): Mono | undefined {
  return addStarterMono("coordinator");
}

export function openChiefChat(monoId: string): void {
  if (!monoId.trim()) return;
  openMonoChat(monoId);
}
