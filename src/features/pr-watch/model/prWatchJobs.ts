// Being built, for watched pull requests: each live watch is a job under the Mono that owns it, "Waiting on CI"
// instead of nothing while the Mono is idle. Ash OS's own jobs know nothing of these; they come from this app's rows.
import { clockLabel } from "../../hub/model/liveJobs";
import type { Worker } from "../../hub/model/types";
import { prWatchLine, type PrWatch } from "./prWatches";

const minutesSince = (ms: number | null, now: number) =>
  ms == null ? 0 : Math.max(0, Math.floor((now - ms) / 60_000));

const iso = (ms: number) => new Date(ms).toISOString();

/** A live watch as one Being built row. */
export function prWatchWorker(watch: PrWatch, now: number): Worker {
  const steps: Worker["steps"] = [];
  const add = (ms: number | null, text: string) =>
    ms != null && steps.push({ id: `pr:${watch.id}:${steps.length}`, at: clockLabel(iso(ms)), text });
  add(watch.lastReadAt, `Checked GitHub: ${prWatchLine(watch)}`);
  if (watch.wakesTotal) add(watch.updatedAt, `Woke ${watch.ownerName ?? "its Mono"} ${watch.wakesTotal === 1 ? "once" : `${watch.wakesTotal} times`}`);
  if (watch.worktree) add(watch.createdAt, `Checkout: ${watch.worktree}`);
  add(watch.createdAt, `Started watching ${watch.repo}#${watch.number}`);
  return {
    id: `pr:${watch.id}`,
    projectId: watch.project ?? "",
    who: watch.ownerName ?? "Lead",
    kind: "mono",
    doing: `PR #${watch.number}: ${watch.title || watch.repo}`,
    minutes: minutesSince(watch.createdAt, now),
    activeAgo: minutesSince(watch.lastReadAt, now),
    steps,
    state: "waiting_ci",
    prWatch: { id: watch.id, ownerSession: watch.ownerSession, url: watch.url, line: prWatchLine(watch) },
  };
}

/** The project's live watches as rows, oldest first. */
export function prWatchWorkers(watches: readonly PrWatch[], projectId: string, now: number): Worker[] {
  return watches
    .filter((watch) => watch.state === "watching" && watch.project === projectId)
    .map((watch) => prWatchWorker(watch, now));
}
