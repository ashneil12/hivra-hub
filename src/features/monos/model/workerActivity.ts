// What each chat's running worker is doing now, for the parent turn's live step line and the room's (r62, PM's live
// line: "Waiting on a worker" told Ash nothing, and a worker busy for minutes left its parent reading "No activity").
// Read from each worker's own stream with the same clocks as any live turn; a worker that isn't working says nothing.
import { noteWorkerProgress, trackActivity, type WorkerProgress } from "../../sessions/model/liveActivity";
import type { Block, Session } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation } from "./delegations";

/** The worker's current turn: its blocks after its latest visible message in. */
export function currentTurn(blocks: readonly Block[]): Block[] {
  let at = -1;
  for (let i = blocks.length - 1; i >= 0; i--)
    if (blocks[i].role === "user") {
      at = i;
      break;
    }
  return blocks.slice(at + 1);
}

/** Owners seen last time, so one whose workers stopped is cleared. */
const published = new Set<string>();

/**
 * Publishes, for each chat with an open delegation whose worker chat is busy here, that worker's step and last event
 * (the newest of its workers when it has several). Returns what it published, by owner.
 */
export function publishWorkerProgress(rows: readonly Delegation[], sessions: readonly Session[], now = Date.now()): Map<string, WorkerProgress> {
  const out = new Map<string, WorkerProgress>();
  for (const row of rows) {
    if (!isOpenDelegation(row)) continue;
    const child = sessions.find((s) => s.id === row.childSession);
    if (!child?.busy) continue;
    const activity = trackActivity(`worker:${child.id}`, currentTurn(child.blocks), now, child.cwd, undefined, undefined, { detail: "name" });
    const had = out.get(row.ownerSession);
    if (!had || activity.lastEventAt > had.lastEventAt) out.set(row.ownerSession, { label: activity.label, lastEventAt: activity.lastEventAt });
  }
  for (const owner of published) if (!out.has(owner)) noteWorkerProgress(owner, undefined);
  published.clear();
  for (const [owner, progress] of out) {
    noteWorkerProgress(owner, progress);
    published.add(owner);
  }
  return out;
}
