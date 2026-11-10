// WP-165: the morning list. It shows drafts that are waiting or parked. It never starts, merges or spends.

import type { ProgrammeRow } from "./programme";

export type MorningDraft = {
  id: string;
  title: string;
  parked: boolean;
  brief: string;
};

/** Queued and parked drafts, newest first. A building, merged or failed row is not on this list. */
export function morningDrafts(rows: readonly ProgrammeRow[], briefs: Readonly<Record<string, string>>): MorningDraft[] {
  return rows
    .filter((row) => row.draft === true && (row.status === "queued" || row.status === "parked") && row.title.trim())
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .map((row) => ({
      id: row.id,
      title: row.title,
      parked: row.status === "parked" || row.securityPark === true,
      brief: typeof briefs[row.id] === "string" ? briefs[row.id] : "",
    }));
}
