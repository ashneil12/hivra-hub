import { useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowLeft, Terminal, Wrench } from "../../../shared/ui/icons";
import { hubData } from "../model/hubData";
import { setHubSelection } from "../model/hubNav";
import { activeWorkers, durationLabel, finishedToday, getWorker } from "../model/hubWork";
import type { Worker } from "../model/types";
import { StatusMark } from "./StatusMark";
import { findWaiting } from "../model/waiting";

/** Running work, one calm line per worker; click for its activity. */
export function BeingBuiltView({ projectId }: { projectId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const open = openId ? getWorker(openId) : undefined;
  const active = activeWorkers(projectId);
  const done = finishedToday(projectId);
  const projectName = hubData().listProjects().find((p) => p.id === projectId)?.name ?? projectId;

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
        <span className="min-w-0 truncate text-[13px] text-content">{open ? open.who : "Being built"}</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {open ? (
          <Activity worker={open} />
        ) : active.length || done.length ? (
          <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-8 py-8">
            {active.length ? (
              <div className="flex flex-col gap-0.5">
                {active.map((w) => <WorkerLine key={w.id} w={w} onOpen={setOpenId} />)}
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
                {showDone ? done.map((w) => <WorkerLine key={w.id} w={w} onOpen={setOpenId} />) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid h-full place-items-center px-8" data-hub-being-built-empty>
            <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
              <p className="text-[13px] text-content">Nobody's working on {projectName} right now.</p>
              <p className="text-[13px] leading-5 text-content/60">
                When the coding team or a Mono starts on something, it shows up here as one line: who, what they're doing, and for how long.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkerLine({ w, onOpen }: { w: Worker; onOpen: (id: string) => void }) {
  return (
    <div role="button" tabIndex={0} data-hub-worker={w.id} onClick={() => onOpen(w.id)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(w.id)}
      className="flex cursor-default items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-content/5">
      <span className="w-32 shrink-0 truncate text-[13px] text-content">{w.who}</span>
      <span className={`min-w-0 flex-1 truncate text-[13px] ${w.finishedAt ? "text-content/60" : "text-content/85"}`}>{w.doing}</span>
      {w.stuck ? <StatusMark state={w.stuck} /> : null}
      <span className="shrink-0 text-xs text-content/60">
        {w.finishedAt ? `Done ${w.finishedAt}` : `for ${durationLabel(w.minutes)}`}
      </span>
      {w.stuck && !w.finishedAt ? <WorkerTakeLook w={w} /> : null}
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
            {worker.finishedAt ? `Finished ${worker.finishedAt}` : `${live ? "Working" : "At it"} for ${durationLabel(worker.minutes)}`}
          </div>
        </div>
        {worker.stuck ? <StatusMark state={worker.stuck} /> : null}
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
