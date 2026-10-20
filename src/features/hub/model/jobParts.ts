import type { Worker } from "./types";

/**
 * A big job the Lead split over several workers is one row: "Rebuild the waitlist, 1 of 3 parts done", which opens
 * to its parts. The row sits where its first part was, so nothing re-sorts. It is Done (with the time the last part
 * finished) only once every part is; until then it is the busiest state among the parts that are still going.
 */
export function foldParts(rows: Worker[]): Worker[] {
  const out: Worker[] = [];
  const big = new Map<string, Worker>();
  for (const w of rows) {
    if (!w.parentId) {
      out.push(w);
      continue;
    }
    let row = big.get(w.parentId);
    if (!row) {
      row = { id: `big:${w.parentId}`, projectId: w.projectId, who: w.who, kind: w.kind, doing: w.parentTitle ?? w.doing, minutes: 0, steps: [], parts: [] };
      big.set(w.parentId, row);
      out.push(row);
    }
    row.parts!.push(w);
  }
  for (const row of big.values()) Object.assign(row, summarise(row.parts!));
  return out;
}

export function partsDone(row: Worker): number {
  return (row.parts ?? []).filter((p) => p.finishedAt).length;
}

function summarise(parts: Worker[]): Partial<Worker> {
  const open = parts.filter((p) => !p.finishedAt);
  const minutes = Math.max(0, ...parts.map((p) => p.minutes));
  const activeAgo = Math.min(...parts.map((p) => p.activeAgo ?? 0));
  const steps = parts.flatMap((p) => p.steps.map((s) => ({ ...s, id: `${p.id}:${s.id}`, text: `${p.doing}: ${s.text}` })));
  if (!open.length) {
    const sorted = parts.map((p) => p.finishedAt!).sort(byClock);
    const last = sorted[sorted.length - 1];
    return { minutes, activeAgo, steps, finishedAt: last, seen: parts.every((p) => p.seen) };
  }
  const stuck = open.find((p) => p.stuck);
  if (stuck)
    return {
      minutes, activeAgo, steps, stuck: stuck.stuck, stuckReason: stuck.stuckReason, waitingId: stuck.waitingId, sentNote: stuck.sentNote,
      ...(stuck.stuckWorker ? { stuckWorker: stuck.stuckWorker } : {}), lead: stuck.lead,
    };
  const order: NonNullable<Worker["state"]>[] = ["needs_you", "waiting", "working", "checking", "parked", "unknown"];
  const state = order.find((s) => open.some((p) => (p.state ?? "working") === s)) ?? "working";
  const waiting = state === "waiting" ? open.find((p) => p.state === "waiting") : undefined;
  return {
    minutes, activeAgo, steps, state,
    ...(waiting?.stateReason ? { stateReason: waiting.stateReason } : {}),
    ...(waiting?.stuckWorker ? { stuckWorker: waiting.stuckWorker } : {}),
  };
}

/** "9:05am" < "11:56am" < "2:10pm". */
function byClock(a: string, b: string): number {
  const v = (t: string) => {
    const m = /^(\d+):(\d+)(am|pm)$/.exec(t);
    return m ? ((+m[1] % 12) + (m[3] === "pm" ? 12 : 0)) * 60 + +m[2] : 0;
  };
  return v(a) - v(b);
}
