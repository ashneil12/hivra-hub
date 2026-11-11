// WP-219: the only count adapter. Until WP-210 (PR #243) lands
// src/features/needs/model/needsYou.ts (`needsCount`), the live readers below
// call today's needs rows and working delegations. Swapping that later is this file.

import { delegationRows } from "../../monos/model/delegationStore";
import { stuckWorkers } from "../../monos/model/workerStuck";
import { needsYouRows } from "../../hub/model/needsYouRows";
import { stuckProject } from "../../hub/model/todayCounts";

export function chipCounts(source: { needs: number; working: number }): { needsYou: number; working: number } {
  return { needsYou: count(source.needs), working: count(source.working) };
}

function count(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Needs you and working, from today's lists. Replace this body with WP-210's
 * `needsCount` and its working count when that list is on main.
 */
export function liveBoardCounts(now = Date.now()): { needsYou: number; working: number } {
  try {
    const rows = delegationRows();
    const needs = needsYouRows([], stuckWorkers(rows, now), (stuck) => stuckProject(stuck)?.id).length;
    const working = rows.filter((row) => row.status === "working").length;
    return chipCounts({ needs, working });
  } catch {
    return { needsYou: 0, working: 0 };
  }
}
