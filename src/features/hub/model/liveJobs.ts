// Being built, live: Ash OS's jobs shown with the same rows the example data uses. One row per job under the Mono
// running it. Nothing about helpers or workers: a job is what is being done, who runs it and how it is going.
import { useEffect, useState } from "react";
import type { HubJob, HubJobGroup, Worker } from "./types";

/** "2:20pm", from an ISO time, in the Mac's own time zone (what Ash reads). */
export function clockLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

const minutesBetween = (fromIso: string, toMs: number): number => {
  const from = new Date(fromIso).getTime();
  return Number.isNaN(from) ? 0 : Math.max(0, Math.floor((toMs - from) / 60_000));
};

/** What the sheet of steps under a job says, newest first, from what Ash OS tells about the job. */
function stepsOf(job: HubJob): Worker["steps"] {
  const steps: Worker["steps"] = [];
  const add = (iso: string | undefined, text: string) => iso && text && steps.push({ id: `${job.id}:${steps.length}`, at: clockLabel(iso), text });
  if (job.state === "done") add(job.finishedAt ?? job.lastActiveAt, "Finished");
  if (job.state === "lead_gave_up") add(job.lastActiveAt, job.why ?? "The coding team lead gave up. It needs you.");
  if (job.tried?.length) add(job.lastActiveAt, `Tried: ${job.tried.join("; ")}`);
  if (job.gotIt) add(job.gotIt.at, `Coding team lead: ${job.gotIt.text}`);
  if (job.sentText) add(job.state === "sent_to_lead" || job.state === "lead_gave_up" ? job.lastActiveAt : undefined, job.sentText);
  if ((job.state === "stuck" || job.state === "sent_to_lead") && job.reason) add(job.lastActiveAt, job.reason);
  add(job.startedAt, "Started");
  return steps;
}

/** A job as one row. `now` (ms) is what "last active" and "at it for" are counted from; it ticks, the order never does. */
export function workerOf(job: HubJob, group: HubJobGroup, now: number): Worker {
  const w: Worker = {
    id: job.id,
    projectId: job.projectId,
    who: group.leadName,
    kind: "mono",
    doing: job.title,
    minutes: minutesBetween(job.startedAt, job.finishedAt ? new Date(job.finishedAt).getTime() : now),
    steps: stepsOf(job),
    activeAgo: minutesBetween(job.lastActiveAt, now),
    ...(job.parentId ? { parentId: job.parentId, parentTitle: job.parentTitle ?? job.title } : {}),
  };
  switch (job.state) {
    case "checking":
      w.state = "checking";
      break;
    case "stuck":
    case "sent_to_lead":
      // Amber, "Stuck", the reason on the second line, then when it was sent and the Lead's "Got it".
      w.stuck = "stuck";
      w.stuckReason = job.reason;
      if (job.sentText) w.sentNote = job.gotIt ? `${job.sentText} · ${job.gotIt.text}` : job.sentText;
      break;
    case "lead_gave_up":
      // Ash's default: red "Stuck", the reason on the second line (the same as Today). "Needs you" only behind the
      // `monocode:hub-gaveup-style=needs_you` dev flag (see jobState).
      w.stuck = "lead_gave_up";
      w.stuckReason = job.reason || job.why || undefined;
      break;
    case "parked":
      w.state = "parked";
      break;
    case "done":
      w.finishedAt = clockLabel(job.finishedAt ?? job.lastActiveAt);
      w.seen = job.seen;
      break;
    default:
      break;
  }
  return w;
}

/** Every job, in the order Ash OS lists them (it never re-sorts), as rows. */
export function workersFromJobs(groups: HubJobGroup[], now: number): Worker[] {
  return groups.flatMap((g) => g.jobs.map((j) => workerOf(j, g, now)));
}

/** A clock that ticks every `ms` so "2m" turns into "3m" in place; nothing moves. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
