// Being built, with what this app knows about its own workers (H4). Ash OS's job reads "working" while any worker under
// it runs (Ash OS's job_sources.py `_summary`), so a failed or stalled worker beside a running one was
// hidden, and a stalled one is invisible to it. The app has the rows behind each job (by its sourceRef), so it lays its
// stuck workers over the jobs: a job with a stuck worker reads Stuck with that worker's reason, and carries the worker
// so the row can open its chat or answer it. A question on its Lead reads Waiting, with the question, however long it
// sits (D5, Ash 21 Oct: the Lead asks Ash in the Lead's own chat and relays the answer).
import type { Delegation } from "../../monos/model/delegations";
import { questionWithoutOptions } from "../../monos/model/stuckActions";
import { stuckForJob } from "../../monos/model/workerStuck";
import type { Worker } from "./types";

export function withStuckWorkers(rows: readonly Worker[], delegations: readonly Delegation[], now: number): Worker[] {
  if (!delegations.length) return [...rows];
  return rows.map((w) => {
    if (w.finishedAt || w.state === "parked" || !w.sourceRef) return w;
    const stuck = stuckForJob(w.sourceRef, delegations, now);
    if (!stuck) return w;
    // Ash OS already says it is stuck, or the Lead gave up: that louder word and reason stay; the worker comes along.
    if (w.stuck) return { ...w, stuckWorker: stuck };
    // A worker's question waits on its Lead however long it sits (D5): the Lead asks Ash in its own chat.
    if (stuck.kind === "asking")
      return { ...w, state: "waiting", stateReason: `Asked: ${questionWithoutOptions(stuck.line)}`, stuckWorker: stuck };
    return { ...w, stuck: "stuck", stuckReason: stuck.line, stuckWorker: stuck };
  });
}
