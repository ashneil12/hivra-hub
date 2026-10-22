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
import { failureChip } from "../model/statusChip";
import { stuckWorkerChip } from "../../monos/model/stuckChip";
import type { StuckWorker } from "../../monos/model/workerStuck";

/**
 * Who a worker answers to, by name: its Mono's ("EXO lead"), or, when that Mono isn't on this Mac, its project's Lead
 * ("Hivra lead"), so a row never says "its Lead" where the project is known.
 */
export function stuckLeadName(s: StuckWorker): string {
  const named = leadNameOf(s);
  if (named !== "its Lead") return named;
  const project = stuckProject(s);
  const short = project?.shortName?.trim() || project?.name.trim();
  return short ? `${short} lead` : named;
}

export { failedMonosFor, monoProject, stuckProject } from "../model/todayCounts";

/**
 * r30, the red rule: no "Stuck" section. What only Ash can sort (a Lead's turn refused for credits or sign-in, a worker
 * refused the same way) is red and sits with Needs you (`tone="red"`); a failed or stalled worker its Lead is handling,
 * or one being retried, is grey and sits with Being built (`tone="grey"`), minus any a Being built job row already
 * shows (`skip`). No heading of its own either way.
 */
export function StuckToday({
  projectId,
  tone = "red",
  skip,
  heading,
}: {
  projectId: string | undefined;
  tone?: "red" | "grey";
  skip?: ReadonlySet<string>;
  /** Today's Being built heading, when there are no job rows to carry it. */
  heading?: string;
}) {
  const { stuck, now } = useStuckWorkers();
  useMonoFailuresVersion();
  // A worker's question is not here (D5, Ash 21 Oct 20:42): its Lead asks Ash in the Lead's own chat and relays the
  // answer, so Ash never goes looking for it or opens the worker. Stalled and failed workers stay.
  const forAsh = stuck.filter((s) => s.kind !== "asking" && !skip?.has(s.key));
  const mine = projectId ? forAsh.filter((s) => stuckProject(s)?.id === projectId) : forAsh;
  const shown = mine.filter((s) => (stuckWorkerChip(s, stuckLeadName(s)).tone === "red") === (tone === "red"));
  const failed = failedMonosFor(projectId).filter((f) => (failureChip(f.tone).tone === "red") === (tone === "red"));
  if (!shown.length && !failed.length) return null;
  return (
    <section aria-label={tone === "red" ? "Needs you" : "Being built"} data-hub-stuck-today={tone} {...(heading ? { "data-hub-today-section": "being-built", "data-hub-today-being-built": true } : {})}>
      {heading ? <h2 className="mb-1 text-xs text-content/60">{heading}</h2> : null}
      {failed.length ? (
        <MonoFailureList
          failures={failed}
          now={now}
          where={(f) => (projectId ? undefined : projectBefore(monoProject(f.monoId), failedMonoName(f)))}
        />
      ) : null}
      <StuckList
        stuck={shown}
        now={now}
        variant="row"
        where={(s) => stuckWhere(projectId ? null : stuckProject(s), stuckLeadName(s))}
        leadName={stuckLeadName}
      />
    </section>
  );
}
