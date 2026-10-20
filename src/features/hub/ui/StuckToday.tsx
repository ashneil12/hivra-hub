// "Stuck" on Today (and a project's Inbox), right above Waiting on you (H4; Ash 20 Oct): every worker that is stuck,
// flagged within a minute, answerable inline: a worker asking its Lead (the Lead answers it when Ash's words cover it;
// Ash can take it first), one that stalled, one that failed. Each row says where it is (project · Lead), what it is
// doing, and offers its question's options or Ash's words, Open (its chat under the Mono), Stop, or Dismiss.
import { projectKey } from "../../../shared/lib/paths";
import { useStuckWorkers } from "../../monos/hooks/useStuckWorkers";
import { findMono, monoForSession } from "../../monos/model/mono";
import type { StuckWorker } from "../../monos/model/workerStuck";
import { leadNameOf, StuckList } from "../../monos/ui/StuckWorkerCard";
import { hubData } from "../model/hubData";
import { leadFor } from "../model/hubLeads";

/** The hub project a stuck worker's work belongs to: its Lead's project, else the row's project or folder. */
export function stuckProject(stuck: Pick<StuckWorker, "row">): { id: string; name: string } | null {
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
  return hit ? { id: hit.id, name: hit.name } : null;
}

export function StuckToday({ projectId }: { projectId: string | undefined }) {
  const { stuck, now } = useStuckWorkers();
  const shown = projectId ? stuck.filter((s) => stuckProject(s)?.id === projectId) : stuck;
  return (
    <StuckList
      heading="Stuck"
      stuck={shown}
      now={now}
      variant="row"
      where={(s) => [projectId ? null : (stuckProject(s)?.name ?? null), leadNameOf(s)].filter(Boolean).join(" · ")}
    />
  );
}
