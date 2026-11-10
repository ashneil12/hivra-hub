// WP-165: one night of drafts, from the sources table and the approved watch summary only.

import { briefText, curate } from "./curate";
import { placeDrafts, type Placement, type ProgrammeRow } from "./programme";
import type { ScoutSettings } from "./settings";

export function runScout(input: {
  settings: ScoutSettings;
  sourcesText: string;
  watchText: string;
  rows: readonly ProgrammeRow[];
  briefs: Readonly<Record<string, string>>;
  now: number;
  projectId: string;
}): Placement {
  const proposals = input.settings.enabled === true ? curate(input.sourcesText, input.watchText) : [];
  return placeDrafts({
    enabled: input.settings.enabled,
    maxDrafts: input.settings.maxDrafts,
    existing: input.rows,
    briefs: input.briefs,
    candidates: proposals.map((proposal) => ({
      source: proposal.source,
      title: proposal.title,
      text: briefText(proposal),
      wp: proposal.packages.length ? String(proposal.packages[0]) : "",
    })),
    now: input.now,
    projectId: input.projectId,
  });
}
