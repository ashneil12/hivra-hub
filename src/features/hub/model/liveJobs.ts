// Being built, live: Ash OS's jobs shown with the same rows the example data uses. One row per job under the Mono
// running it. Nothing about helpers or workers: a job is what is being done, who runs it and how it is going.
import { sentNote } from "./statusChip";
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
function stepsOf(job: HubJob, leadName: string): Worker["steps"] {
  const steps: Worker["steps"] = [];
  const add = (iso: string | undefined, text: string) => iso && text && steps.push({ id: `${job.id}:${steps.length}`, at: clockLabel(iso), text });
  if (job.state === "done") add(job.finishedAt ?? job.lastActiveAt, "Finished");
  if (job.state === "lead_gave_up") add(job.lastActiveAt, job.why ?? `Needs you. Open ${leadName}'s chat to see why.`);
  if (job.tried?.length) add(job.lastActiveAt, `Tried: ${job.tried.join("; ")}`);
  if (job.gotIt) add(job.gotIt.at, `${leadName}: ${job.gotIt.text}`);
  if (job.sentText) add(job.state === "sent_to_lead" || job.state === "lead_gave_up" ? job.lastActiveAt : undefined, sentNote(job.sentText, undefined, leadName) ?? job.sentText);
  if ((job.state === "stuck" || job.state === "sent_to_lead") && job.reason) add(job.lastActiveAt, job.reason);
  add(job.startedAt, "Started");
  return steps;
}

/** A state word as Ash OS sent it, as a label: "blocked_on_ci" reads "Blocked on ci". */
export function plainStateWord(raw: string): string {
  const words = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
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
    steps: stepsOf(job, group.leadName),
    activeAgo: minutesBetween(job.lastActiveAt, now),
    ...(job.parentId ? { parentId: job.parentId, parentTitle: job.parentTitle ?? job.title } : {}),
    ...(job.sourceRef ? { sourceRef: job.sourceRef } : {}),
    lead: job.lead,
  };
  switch (job.state) {
    case "checking":
      w.state = "checking";
      break;
    case "waiting":
      // A worker asked a question and the job waits on its answer: a quiet word, the reason on the second line.
      w.state = "waiting";
      if (job.reason) w.stateReason = job.reason;
      break;
    case "unknown":
      w.state = "unknown";
      w.stateWord = plainStateWord(job.rawState ?? "");
      if (job.reason) w.stateReason = job.reason;
      break;
    case "stuck":
    case "sent_to_lead":
      // Its own state (r27: "stuck" reads a grey Retrying, "sent_to_lead" a grey With <Lead>), the reason on the second
      // line, then when it was sent and the Lead's "Got it".
      w.stuck = job.state;
      w.stuckReason = job.reason;
      // The Lead's name from the same place as the chip's (r27b): "Sent to Hivra lead at 2:20pm", not Ash OS's generic one.
      if (job.sentText) w.sentNote = sentNote(job.sentText, job.gotIt?.text, w.who);
      break;
    case "lead_gave_up":
      // D5 (Ash, 21 Oct 20:40): "Needs you", the reason on the second line (the same as Today). The old red "Stuck"
      // only behind the `monocode:hub-gaveup-style=stuck` dev flag (see jobState).
      w.stuck = "lead_gave_up";
      w.stuckReason = job.reason || job.why || undefined;
      break;
    case "parked":
      // Ash paused it ("Pause this job"). Ash OS stamps the pause as finishedAt: that is when it was paused, never how
      // long it ran (r28b).
      w.state = "parked";
      if (job.finishedAt) w.pausedSince = clockLabel(job.finishedAt);
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

/**
 * A job whose Lead can't answer (its last turn failed: out of credits, overloaded) reads Stuck with that reason, whatever
 * Ash OS last heard: nothing moves until it is dealt with. `failureOf` gives the Lead's failure and name, if any.
 */
export function withFailedLeads(
  rows: readonly Worker[],
  failureOf: (monoId: string) => { name: string; reason: string; tone: "red" | "amber" } | undefined,
): Worker[] {
  return rows.map((w) => {
    if (w.finishedAt || w.stuck || w.state === "parked" || !w.lead) return w;
    const failed = failureOf(w.lead);
    return failed ? { ...w, stuck: "stuck", leadCantAnswer: failed.tone, stuckReason: `${failed.name} can't answer: ${failed.reason}` } : w;
  });
}
