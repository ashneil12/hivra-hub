// What Ash reads for the Lead a group of jobs sits under: its role, "<Project> lead" ("Hub lead", "EXO lead"), never the
// Mono id Ash OS may send as the name ("ash-lead") or an older wording ("studio lead"). Ash OS sends `leadName` as the
// Lead's seat says it; the app maps it here, so Ash OS's text is left as it is (r28 item 9).
import { leadFor } from "./hubLeads";
import type { HubJobGroup, HubProject } from "./types";

const ID_LIKE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
const OLD_WORDING = /\bstudio lead\b/i;

export function roleLeadName(project: Pick<HubProject, "id" | "name" | "shortName"> | undefined, leadId: string | null, leadName: string): string {
  if (!project) return leadName;
  const role = `${(project.shortName || project.name).trim()} lead`;
  const lead = leadId ? leadFor(leadId) : undefined;
  // The project's own Lead (its id, or the old seat it adopted: ash-lead is the Hub's Lead).
  if (lead?.projectId === project.id || leadId === `${project.id}-lead`) return role;
  // Not the project's Lead (Chief of Staff, or another Mono): its own name, unless that name is only an id.
  const name = leadName.trim();
  if (ID_LIKE.test(name) && (leadFor(name)?.projectId === project.id || name === `${project.id}-lead`)) return role;
  if (OLD_WORDING.test(name)) return role;
  return leadName;
}

export function withRoleLeadNames(groups: readonly HubJobGroup[], projectOf: (id: string) => HubProject | undefined): HubJobGroup[] {
  return groups.map((g) => {
    const leadName = roleLeadName(projectOf(g.projectId), g.leadId, g.leadName);
    if (leadName === g.leadName) return g;
    return { ...g, leadName, jobs: g.jobs.map((j) => (j.leadName && j.leadName !== leadName && j.leadName === g.leadName ? { ...j, leadName } : j)) };
  });
}
