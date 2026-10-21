// "Stuck" on Today (and a project's Inbox), right above Waiting on you (H4; Ash 20 Oct): a Mono whose last turn failed
// ("Tally lead can't answer: Out of credits", with Try again), then every worker that is stuck, flagged within a minute,
// answerable inline: a worker asking its Lead (the Lead answers it when Ash's words cover it; Ash can take it first), one
// that stalled, one that failed. Each row says where it is (project · Lead), what it is doing, and offers its question's
// options or Ash's words, Open (its chat under the Mono), Stop, or Dismiss. The project is named before the Mono unless
// the Mono's own name carries it ("EXO lead", not "EXO · EXO lead"; stuckWhere.ts).
import { useStuckWorkers } from "../../monos/hooks/useStuckWorkers";
import { failedMonoName, useMonoFailuresVersion } from "../../monos/model/monoFailures";
import { MonoFailureList } from "../../monos/ui/MonoFailureCard";
import { leadNameOf, StuckList } from "../../monos/ui/StuckWorkerCard";
import { projectBefore, stuckWhere } from "../model/stuckWhere";
import { failedMonosFor, monoProject, stuckProject } from "../model/todayCounts";

export { failedMonosFor, monoProject, stuckProject } from "../model/todayCounts";

export function StuckToday({ projectId }: { projectId: string | undefined }) {
  const { stuck, now } = useStuckWorkers();
  useMonoFailuresVersion();
  // A worker's question is not here (D5, Ash 21 Oct 20:42): its Lead asks Ash in the Lead's own chat and relays the
  // answer, so Ash never goes looking for it or opens the worker. Stalled and failed workers stay.
  const forAsh = stuck.filter((s) => s.kind !== "asking");
  const shown = projectId ? forAsh.filter((s) => stuckProject(s)?.id === projectId) : forAsh;
  const failed = failedMonosFor(projectId);
  const workers = (
    <StuckList
      heading={failed.length ? undefined : "Stuck"}
      stuck={shown}
      now={now}
      variant="row"
      where={(s) => stuckWhere(projectId ? null : stuckProject(s), leadNameOf(s))}
    />
  );
  if (!failed.length) return workers;
  return (
    <section aria-label="Stuck" data-hub-stuck>
      <h2 className="mb-1 text-xs text-content/60">Stuck</h2>
      <MonoFailureList
        failures={failed}
        now={now}
        where={(f) => (projectId ? undefined : projectBefore(monoProject(f.monoId), failedMonoName(f)))}
      />
      {workers}
    </section>
  );
}
