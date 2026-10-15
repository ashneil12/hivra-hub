import { useEffect, useRef, useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowLeft, Terminal, Wrench } from "../../../shared/ui/icons";
import { hubData, useHubDataVersion } from "../model/hubData";
import { useNow, workersFromJobs } from "../model/liveJobs";
import { setHubSelection } from "../model/hubNav";
import { activeWorkers, archiveIfSeen, durationLabel, finishedToday, getWorker, jobState, markSeen, useWorkVersion } from "../model/hubWork";
import type { Worker } from "../model/types";
import { findWaiting } from "../model/waiting";

/** Running work, one calm line per worker; click for its activity. */
export function BeingBuiltView({ projectId }: { projectId: string }) {
  useWorkVersion();
  useHubDataVersion();
  const data = hubData();
  // Live: Ash OS's jobs (done ones stay, with a dot, until Ash has seen them and left). Examples: the mock store.
  const live = !!data.listJobs;
  const now = useNow(30_000);
  const liveWorkers = live ? workersFromJobs(data.listJobs?.(projectId) ?? [], now) : [];
  const [openId, setOpenIdRaw] = useState<string | null>(null);
  const setOpenId = (id: string | null) => {
    if (openId) archiveIfSeen(openId);
    if (id) markSeen(id);
    setOpenIdRaw(id);
  };
  const [showDone, setShowDone] = useState(false);
  const open = openId ? (live ? liveWorkers.find((w) => w.id === openId) : getWorker(openId)) : undefined;
  const active = live ? liveWorkers : activeWorkers(projectId);
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
          <Activity worker={open} />
        ) : active.length || done.length ? (
          <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-8 py-8">
            {active.length ? (
              <div className="flex flex-col gap-4">
                {byMono(active).map(([mono, jobs]) => (
                  <div key={mono} className="flex flex-col gap-0.5" data-hub-mono-jobs={mono}>
                    <div className="px-3 text-xs text-content/60">{mono}</div>
                    {jobs.map((w) => <WorkerLine key={w.id} w={w} onOpen={setOpenId} showWho={!live} />)}
                  </div>
                ))}
              </div>
            ) : (
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
function WorkerLine({ w, onOpen, showWho }: { w: Worker; onOpen: (id: string) => void; showWho: boolean }) {
  return (
    <div role="button" tabIndex={0} data-hub-worker={w.id} onClick={() => onOpen(w.id)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(w.id)}
      className="hub-fade-in flex cursor-default items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-content/5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate text-[13px] ${w.finishedAt ? "text-content/60" : "text-content"}`}>
          {w.doing}
          {w.finishedAt && showWho ? <span className="text-content/60"> · {w.who}</span> : null}
        </span>
        {w.stuck && w.stuckReason ? (
          <span className="truncate text-xs text-content/60" data-hub-job-reason>{w.stuckReason.replace(/^Example: /, "")}</span>
        ) : null}
        {w.stuck && w.sentNote ? <span className="truncate text-xs text-content/60" data-hub-job-sent>{w.sentNote}</span> : null}
      </span>
      <span className="flex w-28 shrink-0 justify-end"><JobStateLabel w={w} compact /></span>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-content/60" data-hub-last-active>
        {`for ${durationLabel(w.minutes)}`}
      </span>
      <span className="flex w-24 shrink-0 justify-end">{w.stuck && !w.finishedAt ? <WorkerTakeLook w={w} /> : null}</span>
    </div>
  );
}

function Activity({ worker }: { worker: Worker }) {
  const live = !worker.finishedAt && !worker.stuck;
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-8 py-8" data-hub-activity>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] text-content">{worker.doing}</div>
          <div className="flex items-center gap-1.5 text-[13px] text-content/60">
            {live ? <span className="size-1.5 animate-pulse rounded-full bg-content/60" /> : null}
            {worker.who} · {`${worker.finishedAt ? "took" : live ? "working" : "at it"} ${worker.finishedAt ? "" : "for "}${durationLabel(worker.minutes)}`}
          </div>
        </div>
        <JobStateLabel w={worker} />
        {worker.stuck ? <WorkerTakeLook w={worker} /> : null}
        {worker.kind === "coding" ? (
          <button type="button" data-hub-open-coding onClick={() => setHubSelection({ project: worker.projectId, item: "coding-team" })}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12">
            <Terminal className="size-3" strokeWidth={1.75} /> Open in coding team
          </button>
        ) : null}
      </div>
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

/** Reads the shared waiting list; opens the item in the project's Inbox. */
function WorkerTakeLook({ w: worker }: { w: Worker }) {
  const w = findWaiting(worker.waitingId ?? `worker:${worker.id}`);
  if (!w) return null;
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

/** Calm state text. Stuck = amber circle (still fixing itself). Needs you is a
 * dot and plain text, like every other state. Lead gave up = red Stuck with the reason (Ash's default). Done (not seen) = small dot. */
function JobStateLabel({ w, compact = false }: { w: Worker; compact?: boolean }) {
  const st = jobState(w);
  const reason = w.stuckReason ? w.stuckReason.replace(/^Example: /, "") : "";
  if (st === "needs_you")
    return (
      <span data-hub-job-state={st} className="flex min-w-0 shrink items-center gap-1.5 text-xs text-content/85">
        <span className="size-1.5 shrink-0 rounded-full bg-content" aria-hidden />
        <span className="shrink-0 text-content">Needs you</span>
        {reason && !compact ? <span className="truncate text-content/60">{reason}</span> : null}
      </span>
    );
  if (st === "stuck" || st === "gave_up")
    return (
      <span data-hub-job-state={st} className="flex min-w-0 shrink items-center gap-1.5 text-xs text-content/85">
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden className="shrink-0">
          <circle cx="7" cy="7" r="6" fill="none" strokeWidth="2" stroke={st === "gave_up" ? "rgb(239 68 68)" : "rgb(245 158 11)"} />
        </svg>
        <span className="truncate">Stuck{reason && !compact ? `: ${reason}` : ""}</span>
      </span>
    );
  if (st === "done_unseen")
    return (
      <span data-hub-job-state={st} className="flex shrink-0 items-center gap-1.5 text-xs text-content/85">
        <span className="size-1.5 rounded-full bg-content" aria-label="Not seen yet" />Done
      </span>
    );
  const text = { working: "Working", checking: "Checking", parked: "Parked", done: "Done" }[st];
  return <span data-hub-job-state={st} className="shrink-0 text-xs text-content/60">{text}</span>;
}
