// How many workers a project runs at once (board H8). Ash, 16 Oct 17:40: "maybe today I want, like, 10 or 20 parallel
// workers, obviously ones that need to do heavy testing, then it would get throttled. But then it's really a
// per-project thing".
// - Per project: how many workers run at once, and how many of them may run heavy tests at once (full suites, e2e,
//   builds). Defaults below; Ash changes either in the project's settings, or by telling its Lead ("let hivra run 20
//   workers today"), which saves it with workers.limit.
// - The Lead decides on its own which work is heavy (delegate_task `heavy`) and never manages the queue: a worker over
//   the limit waits as a card that says so ("Waiting for a free worker") and starts by itself when one frees up, in
//   the order it was asked for. A waiting heavy job never holds up light ones behind it.
// - Provider limits back off instead of failing: while every account of the worker's provider is out (E5's account
//   order and limit marks, providers/model/accountWaterfall.ts), new workers wait until one rejoins; a running worker
//   the provider refuses keeps its task (App.tsx holds its report) and carries on on the next account with room, or
//   at the reset.
// - No cost ceiling: Ash handles cost himself, so nothing here counts money or tokens.
// Workers never step on each other: several in one repo each get a checkout of their own (agentAppTasks.ts), across
// every chat working on the project, not only the one delegating.
import { useSyncExternalStore } from "react";
import type { WorkerPoolHost } from "../../agent-app/model/agentAppTasks";
import type { Delegation } from "./delegations";
import { isOpenDelegation } from "./delegations";

export type WorkerLimits = { workers: number; heavy: number };
/** A sensible start; Ash raises it per project when he wants more at once. */
export const DEFAULT_LIMITS: WorkerLimits = { workers: 6, heavy: 2 };
export const MAX_WORKERS = 30;

const LIMITS_KEY = "monocode.workerLimits.v1";
const HEAVY_KEY = "monocode.heavyWorkers.v1";
const QUEUE_KEY = "monocode.workerQueue.v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full: this launch still holds it */
  }
}

let version = 0;
const listeners = new Set<() => void>();
function changed(): void {
  version++;
  for (const l of [...listeners]) l();
}
export function subscribeWorkerPool(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useWorkerPoolVersion(): number {
  return useSyncExternalStore(subscribeWorkerPool, () => version, () => version);
}

// ---- limits ------------------------------------------------------------------------------------------------------

const clampCount = (n: unknown, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_WORKERS, Math.max(1, Math.round(n))) : fallback;

export function workerLimits(project: string): WorkerLimits {
  const saved = read<Record<string, Partial<WorkerLimits>>>(LIMITS_KEY, {})[project];
  const workers = clampCount(saved?.workers, DEFAULT_LIMITS.workers);
  return { workers, heavy: Math.min(workers, clampCount(saved?.heavy, Math.min(workers, DEFAULT_LIMITS.heavy))) };
}

/** Saves one project's limits (either part); heavy never exceeds workers. Returns what is now in force. */
export function setWorkerLimits(project: string, next: Partial<WorkerLimits>): WorkerLimits {
  const all = read<Record<string, Partial<WorkerLimits>>>(LIMITS_KEY, {});
  const now = workerLimits(project);
  const workers = next.workers === undefined ? now.workers : clampCount(next.workers, now.workers);
  const heavy = Math.min(workers, next.heavy === undefined ? now.heavy : clampCount(next.heavy, now.heavy));
  write(LIMITS_KEY, { ...all, [project]: { workers, heavy } });
  changed();
  return { workers, heavy };
}

/** "Hivra runs up to 6 workers at once, 2 of them on heavy tests." */
export function limitsLine(projectName: string, limits: WorkerLimits): string {
  return `${projectName} runs up to ${limits.workers} ${limits.workers === 1 ? "worker" : "workers"} at once, ${limits.heavy} of them on heavy tests.`;
}

// ---- heavy workers -----------------------------------------------------------------------------------------------

/** The Lead said this worker's job is heavy (it runs full test suites, e2e or builds). */
export function markHeavy(childSession: string): void {
  const all = read<string[]>(HEAVY_KEY, []);
  if (all.includes(childSession)) return;
  write(HEAVY_KEY, [...all, childSession].slice(-500));
}
export function isHeavy(childSession: string): boolean {
  return read<string[]>(HEAVY_KEY, []).includes(childSession);
}

// ---- what is running ---------------------------------------------------------------------------------------------

export type ProjectLoad = { running: number; heavy: number };

/** A project's workers still running or asking, from every chat that works on it (a Lead's brief to a Lead isn't one). */
export function projectLoad(
  project: string,
  rows: readonly Pick<Delegation, "project" | "state" | "childSession" | "follow">[],
  heavy: (childSession: string) => boolean = isHeavy,
): ProjectLoad {
  const open = rows.filter((r) => r.project === project && isOpenDelegation(r) && !r.follow);
  return { running: open.length, heavy: open.filter((r) => heavy(r.childSession)).length };
}

// ---- provider room (E5) ------------------------------------------------------------------------------------------

/** Whether the worker's provider has an account with room now; if not, when the first one comes back (if known). */
export type ProviderRoom = { room: true } | { room: false; provider: string; until?: number };

// ---- the queue ---------------------------------------------------------------------------------------------------

export type QueuedWorker = {
  /** The worker chat it will be (`app-<owner>-<request>`), so its card in the Lead's chat is the same before and after. */
  id: string;
  ownerSession: string;
  requestId: string;
  project: string;
  projectName: string;
  title: string;
  heavy: boolean;
  harness: string;
  queuedAt: number;
  /** delegate_task's own input, to start it with exactly as asked. */
  input: Record<string, unknown>;
};

export function queuedWorkers(): QueuedWorker[] {
  const all = read<QueuedWorker[]>(QUEUE_KEY, []);
  return Array.isArray(all) ? all.filter((q) => q && typeof q.id === "string") : [];
}
export function queuedWorker(id: string): QueuedWorker | undefined {
  return queuedWorkers().find((q) => q.id === id);
}
/** Waits in order; asking again with the same request keeps its place. */
export function enqueueWorker(job: QueuedWorker): void {
  const all = queuedWorkers();
  if (all.some((q) => q.id === job.id)) return;
  write(QUEUE_KEY, [...all, job]);
  changed();
}
export function dequeueWorker(id: string): QueuedWorker | undefined {
  const all = queuedWorkers();
  const job = all.find((q) => q.id === id);
  if (!job) return undefined;
  write(QUEUE_KEY, all.filter((q) => q.id !== id));
  changed();
  return job;
}

// ---- deciding ----------------------------------------------------------------------------------------------------

export type WaitReason = "workers" | "heavy" | "limit";
export type Admission = { start: true } | { start: false; reason: WaitReason; line: string };

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function waitLine(reason: WaitReason, projectName: string, limits: WorkerLimits, room?: ProviderRoom): string {
  if (reason === "limit" && room && !room.room)
    return `Waiting for ${room.provider}'s limit to reset${room.until ? ` at ${clock(room.until)}` : ""}; it starts by itself then.`;
  if (reason === "heavy")
    return `Waiting for a free worker: ${projectName} runs ${limits.heavy} heavy test ${limits.heavy === 1 ? "job" : "jobs"} at once.`;
  return limits.workers === 1
    ? `Waiting for a free worker: ${projectName} runs one at a time.`
    : `Waiting for a free worker: all ${limits.workers} of ${projectName}'s are busy.`;
}

export type AdmitInput = { id: string; project: string; projectName: string; heavy: boolean; harness: string };
export type AdmitContext = {
  rows: readonly Pick<Delegation, "project" | "state" | "childSession" | "follow">[];
  room: (harness: string) => ProviderRoom;
  limits?: (project: string) => WorkerLimits;
  heavy?: (childSession: string) => boolean;
  /** What waits already (queue order); defaults to the saved queue. */
  queue?: readonly QueuedWorker[];
};

function decide(job: AdmitInput, load: ProjectLoad, limits: WorkerLimits, room: ProviderRoom): Admission {
  if (load.running >= limits.workers)
    return { start: false, reason: "workers", line: waitLine("workers", job.projectName, limits) };
  if (job.heavy && load.heavy >= limits.heavy)
    return { start: false, reason: "heavy", line: waitLine("heavy", job.projectName, limits) };
  if (!room.room) return { start: false, reason: "limit", line: waitLine("limit", job.projectName, limits, room) };
  return { start: true };
}

/**
 * A new delegate_task: start now, or wait. It also waits behind work of the same project that is already waiting
 * (first asked, first started), except that a waiting heavy job never holds a light one up.
 */
export function admitWorker(job: AdmitInput, ctx: AdmitContext): Admission {
  const limits = (ctx.limits ?? workerLimits)(job.project);
  const load = projectLoad(job.project, ctx.rows, ctx.heavy);
  const room = ctx.room(job.harness);
  // What already waits in this project starts first, except a heavy job that waits only for a heavy-test slot.
  const heavyFull = load.heavy >= limits.heavy;
  const ahead = (ctx.queue ?? queuedWorkers()).filter(
    (q) => q.project === job.project && q.id !== job.id && !(q.heavy && heavyFull),
  );
  return decide(job, { running: load.running + ahead.length, heavy: load.heavy + ahead.filter((q) => q.heavy).length }, limits, room);
}

/** The waiting workers that can start now, in order, counting each one started against the limits. */
export function nextWorkers(ctx: AdmitContext): QueuedWorker[] {
  const queue = ctx.queue ?? queuedWorkers();
  const loads = new Map<string, ProjectLoad>();
  const start: QueuedWorker[] = [];
  for (const job of queue) {
    const load = loads.get(job.project) ?? projectLoad(job.project, ctx.rows, ctx.heavy);
    loads.set(job.project, load);
    const limits = (ctx.limits ?? workerLimits)(job.project);
    if (!decide(job, load, limits, ctx.room(job.harness)).start) continue;
    start.push(job);
    loads.set(job.project, { running: load.running + 1, heavy: load.heavy + (job.heavy ? 1 : 0) });
  }
  return start;
}

/** Why a waiting worker waits right now (for its card and task_status). */
export function queuedLine(job: QueuedWorker, ctx: AdmitContext): string {
  const limits = (ctx.limits ?? workerLimits)(job.project);
  const load = projectLoad(job.project, ctx.rows, ctx.heavy);
  const room = ctx.room(job.harness);
  const why = decide(job, load, limits, room);
  return why.start ? "Starting now." : why.line;
}

// ---- a running worker the provider refused -----------------------------------------------------------------------

/**
 * A worker's turn ended refused for a usage or rate limit: its task is not failed. App.tsx keeps the row open and
 * doesn't report; E5 moves the chat to the next account with room, or it resumes at the reset, and the resumed turn
 * settles the row as usual (delegations.ts resumeMonitor).
 */
export function holdForLimit(result: { status: string; errorClass?: string; retryable?: boolean }): boolean {
  return result.status === "failed" && result.errorClass === "usage_limit" && result.retryable !== false;
}

/** For tests. */
export function resetWorkerPool(): void {
  for (const key of [LIMITS_KEY, HEAVY_KEY, QUEUE_KEY])
    try {
      localStorage.removeItem(key);
    } catch {
      /* none */
    }
  changed();
}

// ---- the app's side ----------------------------------------------------------------------------------------------

/** Waiting workers the app is starting right now: their own delegate_task, asked again, always starts. */
const startingNow = new Set<string>();

/**
 * What agentAppTasks.ts's delegate reads (App.tsx builds it): the rows of every chat, E5's room per provider, and the
 * card a waiting worker shows in the chat that asked for it.
 */
export function workerPoolHost(deps: {
  openRows(): Delegation[];
  room(harness: string): ProviderRoom;
  /** Put the waiting worker's card in its chat (it shows "Waiting for a free worker" until it starts). */
  card?(job: QueuedWorker, launch: { cwd: string; harness: string; model?: string }): void;
}): WorkerPoolHost {
  const ctx = (): AdmitContext => ({ rows: deps.openRows(), room: deps.room });
  return {
    openRows: deps.openRows,
    admit: (job) => (startingNow.has(job.id) ? { start: true } : admitWorker(job, ctx())),
    enqueue: (job, launch) => {
      enqueueWorker(job);
      deps.card?.(job, launch);
    },
    started: ({ id, heavy }) => {
      if (heavy) markHeavy(id);
      dequeueWorker(id);
    },
    queued: (owner) => {
      const c = ctx();
      return queuedWorkers()
        .filter((job) => job.ownerSession === owner)
        .map((job) => ({ job, line: queuedLine(job, c) }));
    },
    unqueue: (owner, id) => {
      const job = queuedWorker(id);
      if (!job || job.ownerSession !== owner) return false;
      dequeueWorker(id);
      return true;
    },
    limits: workerLimits,
    setLimits: setWorkerLimits,
  };
}

/**
 * Start what can start now (App.tsx calls it whenever a row or a chat changes, and on a timer for provider resets):
 * each through `start`, which asks its own delegate_task again. One that fails to start leaves the queue with the
 * reason, for its chat to hear (`failed`).
 */
export async function pumpWorkers(deps: {
  openRows(): Delegation[];
  room(harness: string): ProviderRoom;
  /** The owner chat can't take it any more (removed): the job is dropped. */
  ownerGone?(job: QueuedWorker): boolean;
  /** Its chat isn't loaded in this window right now: it keeps its place and starts once it is. */
  canStart?(job: QueuedWorker): boolean;
  start(job: QueuedWorker): Promise<unknown>;
  failed?(job: QueuedWorker, error: unknown): void;
}): Promise<QueuedWorker[]> {
  for (const job of queuedWorkers()) if (deps.ownerGone?.(job)) dequeueWorker(job.id);
  const queue = queuedWorkers().filter((job) => deps.canStart?.(job) ?? true);
  if (!queue.length) return [];
  const ready = nextWorkers({ rows: deps.openRows(), room: deps.room, queue }).filter((job) => !startingNow.has(job.id));
  const started: QueuedWorker[] = [];
  for (const job of ready) {
    startingNow.add(job.id);
    try {
      await deps.start(job);
      started.push(job);
    } catch (error) {
      deps.failed?.(job, error);
    } finally {
      startingNow.delete(job.id);
      // Started (delegate dequeued it) or refused: either way it no longer waits.
      dequeueWorker(job.id);
    }
  }
  return started;
}

/** When a waiting worker might start without any row changing: the soonest provider reset among the waiting. */
export function nextWake(room: (harness: string) => ProviderRoom, now: number): number | undefined {
  const times = queuedWorkers().flatMap((job) => {
    const r = room(job.harness);
    return !r.room && r.until && r.until > now ? [r.until] : [];
  });
  return times.length ? Math.min(...times) : undefined;
}
