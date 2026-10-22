import { useEffect, useRef, useState } from "react";
import { workerChip } from "../model/statusChip";
import { ChipMark, LEAD_CHAT_BUTTON, NeedsYouLinkLine } from "./StatusMark";
import { openMonoChat } from "../model/hubNav";
import { rowReason } from "../model/rowReason";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowLeft, ChevronRight, Terminal, Wrench } from "../../../shared/ui/icons";
import { hubData, useHubDataVersion } from "../model/hubData";
import { useNow, withFailedLeads, workersFromJobs } from "../model/liveJobs";
import { openCodingTeam, setHubSelection } from "../model/hubNav";
import { leadFor } from "../model/hubLeads";
import { activeWorkers, archiveIfSeen, durationLabel, finishedToday, getWorker, jobState, jobStateWord, markSeen, useWorkVersion } from "../model/hubWork";
import type { Worker } from "../model/types";
import { findWaiting } from "../model/waiting";
import { foldParts, partsDone } from "../model/jobParts";
import { PausedNote } from "../../autopilot/ui/PausedNote";
import { workflowWorkers } from "../model/workflowJobs";
import { useWorkflowActivityVersion } from "../../sessions/model/workflowActivity";
import { usePrWatchesVersion } from "../../pr-watch/model/prWatchBoard";
import { prWatchWorkers } from "../../pr-watch/model/prWatchJobs";
import { useDelegationRows } from "../../monos/model/delegationStore";
import { useStuckDismissalsVersion } from "../../monos/model/workerStuck";
import { openLead, openStuck } from "../../monos/model/stuckActions";
import { StuckWorkerCard } from "../../monos/ui/StuckWorkerCard";
import { withStuckWorkers } from "../model/stuckJobs";
import { failedMonoName, monoFailure, useMonoFailuresVersion } from "../../monos/model/monoFailures";
import { MonoFailureList } from "../../monos/ui/MonoFailureCard";
import { failedMonosFor } from "../model/todayCounts";

/** Running work, one calm line per worker; click for its activity. */
export function BeingBuiltView({ projectId }: { projectId: string }) {
  useWorkVersion();
  useHubDataVersion();
  useWorkflowActivityVersion();
  const data = hubData();
  // Live: Ash OS's jobs (done ones stay, with a dot, until Ash has seen them and left). Examples: the mock store.
  const live = !!data.listJobs;
  const now = useNow(30_000);
  // Watched pull requests are this app's own jobs: "Waiting on CI" under the Mono that registered them.
  const prWatches = usePrWatchesVersion();
  // This app's own rows behind each job: a stuck worker makes its job Stuck, whatever its siblings do (stuckJobs.ts).
  const delegations = useDelegationRows();
  useStuckDismissalsVersion();
  // A Lead whose last turn failed: listed on top with Try again, and its jobs read Stuck with why.
  useMonoFailuresVersion();
  const failed = failedMonosFor(projectId);
  const leadFailure = (monoId: string) => {
    const failure = monoFailure(monoId);
    return failure ? { name: failedMonoName(failure), reason: failure.reason, tone: failure.tone } : undefined;
  };
  const liveWorkers = live
    ? [
        ...withFailedLeads(withStuckWorkers(workersFromJobs(data.listJobs?.(projectId) ?? [], now), delegations, now), leadFailure),
        ...prWatchWorkers(prWatches?.all() ?? [], projectId, now),
      ]
    : [];
  // Leads running a Claude Code workflow in this app, with where the run is.
  const folder = data.listProjects().find((p) => p.id === projectId)?.folder;
  const workflowRows = workflowWorkers(projectId, folder, Date.now());
  const [openId, setOpenIdRaw] = useState<string | null>(null);
  const setOpenId = (id: string | null) => {
    if (openId) archiveIfSeen(openId);
    if (id) markSeen(id);
    setOpenIdRaw(id);
  };
  const [showDone, setShowDone] = useState(false);
  const open = openId
    ? (workflowRows.find((w) => w.id === openId) ?? (live ? liveWorkers.find((w) => w.id === openId) : getWorker(openId)))
    : undefined;
  const active = foldParts([...workflowRows, ...(live ? liveWorkers : activeWorkers(projectId))]);
  const done = live ? [] : finishedToday(projectId);
  // Finished jobs Ash has had in front of him: when he leaves the page they have been seen and go.
  const shownDone = useRef<string[]>([]);
  shownDone.current = liveWorkers.filter((w) => w.finishedAt).map((w) => w.id);
  // Only a real leave counts: React's dev double-run (unmount, mount) must not mark them seen.
  const here = useRef(false);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
      setTimeout(() => {
        if (!here.current) data.markJobsSeen?.(shownDone.current);
      }, 0);
    };
  }, [data]);
  const projectName = data.listProjects().find((p) => p.id === projectId)?.name ?? projectId;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-being-built>
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        {open ? (
          <button type="button" title="Being built" aria-label="Back to Being built" onClick={() => setOpenId(null)}
            className="grid size-6 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content">
            <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : (
          <Wrench className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
        )}
        <span className="min-w-0 truncate text-[13px] text-content">{open ? open.doing : "Being built"}</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {open ? (
          <Activity worker={open} now={now} />
        ) : active.length || done.length || failed.length ? (
          <div className="flex w-full flex-col gap-5 px-6 py-8 xl:px-8">
            {failed.length ? (
              <section aria-label="Can't answer" className="flex flex-col gap-0.5" data-hub-failed-monos>
                <MonoFailureList failures={failed} now={now} />
              </section>
            ) : null}
            {active.length ? (
              <div className="flex flex-col gap-4">
                {byMono(active).map(([mono, jobs]) => (
                  <div key={mono} className="flex flex-col gap-0.5" data-hub-mono-jobs={mono}>
                    <div className="px-3 text-xs text-content/60">{mono}<PausedNote who={mono} /></div>
                    {jobs.map((w) => <WorkerLine key={w.id} w={w} onOpen={setOpenId} showWho={!live} now={now} />)}
                  </div>
                ))}
              </div>
            ) : failed.length ? null : (
              <p className="px-3 text-[13px] text-content/60">Nobody's working on {projectName} right now.</p>
            )}
            {done.length ? (
              <div className="flex flex-col gap-0.5">
                <button type="button" data-hub-finished-toggle onClick={() => setShowDone((v) => !v)}
                  className="self-start rounded-md px-3 py-1 text-xs text-content/60 hover:bg-content/5 hover:text-content">
                  {showDone ? "Hide" : "Show"} finished today ({done.length})
                </button>
                {showDone ? done.map((w) => <WorkerLine key={w.id} w={w} onOpen={setOpenId} showWho />) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid h-full place-items-center px-8" data-hub-being-built-empty>
            <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
              <p className="text-[13px] text-content">Nobody's working on {projectName} right now.</p>
              <p className="text-[13px] leading-5 text-content/60">
                When a Mono starts a job, it shows up here under that Mono: what the job is, and for how long.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** `showWho`: name the Mono after a finished job's title (in the finished-today list; under a Lead's heading it is redundant). */
/** Under a minute: "just started". Done: the time it finished, like "11:56am". Otherwise how long it has run. */
export function jobTimeLabel(w: Worker): string {
  if (w.finishedAt) return w.finishedAt;
  // A paused job: since when it was paused, if Ash OS said; never the time it ran before (r28b).
  if (jobState(w) === "parked") return w.pausedSince ? `since ${w.pausedSince}` : "";
  if (w.minutes < 1) return "just started";
  return `for ${durationLabel(w.minutes)}`;
}

export function WorkerLine({ w, onOpen, showWho, now = Date.now() }: { w: Worker; onOpen: (id: string) => void; showWho: boolean; now?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [answering, setAnswering] = useState(false);
  const parts = w.parts;
  const toggle = () => (parts ? setExpanded((v) => !v) : onOpen(w.id));
  return (
    <>
    <div role="button" tabIndex={0} data-hub-worker={w.id} data-hub-job-parts={parts ? parts.length : undefined}
      aria-expanded={parts ? expanded : undefined} onClick={toggle}
      onKeyDown={(e) => e.key === "Enter" && toggle()}
      className="hub-fade-in flex cursor-default items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-content/5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`flex min-w-0 items-center gap-1 truncate text-[13px] ${w.finishedAt ? "text-content/60" : "text-content"}`}>
          {parts ? (
            <ChevronRight data-hub-parts-chevron aria-hidden strokeWidth={1.75}
              className={`size-3 shrink-0 text-content/50 transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
          ) : null}
          <span className="truncate">{w.doing}
          {parts ? <span className="text-content/60" data-hub-parts-done>, {partsDone(w)} of {parts.length} parts done</span> : null}
          {w.finishedAt && showWho ? <span className="text-content/60"> · {w.who}</span> : null}</span>
        </span>
        {w.stuck && w.stuckReason ? (
          <span className="whitespace-normal break-words text-xs text-content/60" data-hub-job-reason>{rowReason(w.stuckReason)}</span>
        ) : null}
        {/* A red Needs you: its reason is the line above, and the Lead's chat is one click away (r27b). */}
        {workerChip(w)?.tone === "red" && w.lead ? (
          <div data-hub-job-needs><NeedsYouLinkLine name={w.who} onOpen={() => openLead(w.lead) || openMonoChat(w.lead!)} /></div>
        ) : null}
        {w.stuck && w.sentNote ? <span className="whitespace-normal break-words text-xs text-content/60" data-hub-job-sent>{w.sentNote}</span> : null}
        {!w.stuck && w.stateReason ? <span className="whitespace-normal break-words text-xs text-content/60" data-hub-job-reason>{w.stateReason}</span> : null}
        {w.prWatch ? <span className="whitespace-normal break-words text-xs text-content/60" data-hub-pr-line>{w.prWatch.line}</span> : null}
      </span>
      <span className="flex w-28 shrink-0 justify-end"><JobStateLabel w={w} compact /></span>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-content/60" data-hub-last-active>
        {jobTimeLabel(w)}
      </span>
      <span className="flex w-44 shrink-0 justify-end">
        {w.finishedAt ? null : w.stuckWorker ? (
          <StuckJobAction w={w} answering={answering} onAnswer={() => setAnswering((v) => !v)} />
        ) : w.stuck ? (
          <WorkerTakeLook w={w} />
        ) : null}
      </span>
    </div>
    {answering && w.stuckWorker && !w.finishedAt ? (
      <div className="pl-1" data-hub-job-answer={w.id}>
        <StuckWorkerCard stuck={w.stuckWorker} now={now} variant="row" onDone={() => setAnswering(false)} />
      </div>
    ) : null}
    {parts && expanded ? (
      <div className="flex flex-col gap-0.5 pl-6" data-hub-parts-of={w.id}>
        {parts.map((p) => <WorkerLine key={p.id} w={p} onOpen={onOpen} showWho={false} now={now} />)}
      </div>
    ) : null}
    </>
  );
}

/** A live job a project's Lead runs, in a project with code: it opens in that coding team, on the Lead's chat. */
function inCodingTeam(worker: Worker): boolean {
  return (
    !!worker.lead &&
    !!leadFor(worker.lead) &&
    !!hubData().listProjects().find((project) => project.id === worker.projectId)?.folder
  );
}

function Activity({ worker, now }: { worker: Worker; now: number }) {
  const live = !worker.finishedAt && !worker.stuck;
  return (
    <div className="flex w-full flex-col gap-6 px-6 py-8 xl:px-8" data-hub-activity>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] text-content">{worker.doing}</div>
          <div className="flex items-center gap-1.5 text-[13px] text-content/60">
            {live ? <span className="size-1.5 animate-pulse rounded-full bg-content/60" /> : null}
            {worker.who} · {worker.finishedAt ? `finished ${worker.finishedAt}` : jobState(worker) === "parked" ? `Paused by you${worker.pausedSince ? ` · since ${worker.pausedSince}` : ""}` : worker.minutes < 1 ? "just started" : `${live ? "working" : "at it"} for ${durationLabel(worker.minutes)}`}
          </div>
          {worker.stuck && worker.stuckReason ? (
            <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-job-reason>{worker.stuckReason.replace(/^Example: /, "")}</div>
          ) : !worker.stuck && worker.stateReason ? (
            <div className="whitespace-normal break-words text-[13px] leading-5 text-content/60" data-hub-job-reason>{worker.stateReason}</div>
          ) : null}
        </div>
        <JobStateLabel w={worker} />
        {worker.stuck && !worker.stuckWorker ? <WorkerTakeLook w={worker} /> : null}
        {worker.prWatch ? <StopWatching w={worker} /> : null}
        {worker.kind === "coding" || inCodingTeam(worker) ? (
          <button type="button" data-hub-open-coding onClick={() => openCodingTeam(worker.projectId, { lead: true })}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12">
            <Terminal className="size-3" strokeWidth={1.75} /> Open in coding team
          </button>
        ) : null}
      </div>
      {worker.stuckWorker && !worker.finishedAt ? (
        <section className="flex flex-col gap-1" data-hub-job-stuck-worker>
          {/* r30b: never "Stuck"; the worker's own chip word (With <Lead>, Retrying, or Needs you). */}
          <h2 className="px-2 text-xs text-content/60" data-hub-job-stuck-heading>
            {worker.stuckWorker.kind === "asking" ? "Waiting on an answer" : (workerChip(worker)?.word ?? `With ${worker.who}`)}
          </h2>
          <StuckWorkerCard stuck={worker.stuckWorker} now={now} variant="row" />
        </section>
      ) : null}
      <section className="flex flex-col gap-1">
        <h2 className="px-2 text-xs text-content/60">Recent steps</h2>
        {worker.steps.map((s, i) => (
          <div key={s.id} className="flex gap-4 rounded-md px-2 py-1.5">
            <span className="w-14 shrink-0 text-xs leading-5 text-content/60">{s.at}</span>
            <span className={`text-[13px] leading-5 ${i === 0 ? "text-content" : "text-content/75"}`}>{s.text}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

/** Ash takes a watched pull request back: the app stops waking its Mono about it. */
function StopWatching({ w: worker }: { w: Worker }) {
  const [stopping, setStopping] = useState(false);
  const watch = worker.prWatch;
  const tracker = usePrWatchesVersion();
  if (!watch || !tracker) return null;
  return (
    <button
      type="button"
      data-hub-stop-watching={watch.id}
      disabled={stopping}
      onClick={() => {
        setStopping(true);
        void tracker
          .stop(watch)
          .then(() => tracker.refresh())
          .catch(() => setStopping(false));
      }}
      className="shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50"
    >
      {stopping ? "Stopping…" : "Stop watching"}
    </button>
  );
}

/**
 * A job with a stopped worker under it: one click from the row. A question opens its answer under the row (Answer); a
 * stalled or failed worker opens its Lead's chat ("Open Hivra lead's chat", r30b). A red Needs you already carries
 * that link under its reason, so no second button.
 */
function StuckJobAction({ w, answering, onAnswer }: { w: Worker; answering: boolean; onAnswer: () => void }) {
  const stuck = w.stuckWorker!;
  const asking = stuck.kind === "asking";
  if (!asking && w.lead && workerChip(w)?.tone === "red") return null;
  return (
    <button
      type="button"
      data-hub-stuck-action={asking ? "answer" : "open"}
      aria-expanded={asking ? answering : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (asking) onAnswer();
        else openStuck(stuck);
      }}
      title={asking ? undefined : `Open ${w.who}'s chat`}
      className={`min-w-0 truncate ${LEAD_CHAT_BUTTON}`}
    >
      {asking ? "Answer" : `Open ${w.who}'s chat`}
    </button>
  );
}

/** Reads the shared waiting list; opens the item in the project's Inbox. Without one, a stopped job opens its Lead's chat ("Open Hivra lead's chat"). */
function WorkerTakeLook({ w: worker }: { w: Worker }) {
  const w = findWaiting(worker.waitingId ?? `worker:${worker.id}`);
  if (!w)
    // A red Needs you already carries "Open <Lead>'s chat" under its reason (r27b): no second button for it.
    return worker.lead && !worker.finishedAt && workerChip(worker)?.tone !== "red" ? (
      <button
        type="button"
        data-hub-open-lead={worker.lead}
        onClick={(e) => {
          e.stopPropagation();
          openLead(worker.lead);
        }}
        className={LEAD_CHAT_BUTTON}
      >
        Open {worker.who}&apos;s chat
      </button>
    ) : null;
  return (
    <button
      type="button"
      data-hub-take-look={w.id}
      onClick={(e) => {
        e.stopPropagation();
        setHubSelection({ project: w.projectId, item: "inbox" });
      }}
      className="shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12"
    >
      Take a look
    </button>
  );
}

/** Jobs grouped under the Mono running them, in first-seen order. */
function byMono(jobs: Worker[]): [string, Worker[]][] {
  const m = new Map<string, Worker[]>();
  for (const j of jobs) m.set(j.who, [...(m.get(j.who) ?? []), j]);
  return [...m.entries()];
}

/** Calm state text. A stuck job has Today's chip (statusChip.ts): the red Needs you only when Ash must act, else a
 * grey Retrying (fixing itself) or With <Lead>. Done (not seen) = small dot. */
function JobStateLabel({ w, compact = false }: { w: Worker; compact?: boolean }) {
  const st = jobState(w);
  const reason = rowReason(w.stuckReason);
  const chip = workerChip(w);
  if (chip)
    return (
      <span data-hub-job-state={st} className="flex min-w-0 shrink items-center gap-1.5 text-xs text-content/85">
        <ChipMark chip={chip} />
        {st === "needs_you" && reason && !compact ? <span className="truncate text-content/60">{reason}</span> : null}
      </span>
    );
  if (st === "done_unseen")
    return (
      <span data-hub-job-state={st} className="flex shrink-0 items-center gap-1.5 text-xs text-content/85">
        <span className="size-1.5 rounded-full bg-content" aria-label="Not seen yet" />Done
      </span>
    );
  return <span data-hub-job-state={st} className="shrink-0 text-xs text-content/60">{jobStateWord(w)}</span>;
}
