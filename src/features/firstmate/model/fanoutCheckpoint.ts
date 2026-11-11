// Hivra WP-172: the checkpoint of a First Mate fan-out. A fan-out (delegate_tasks) writes what it has done after each
// task it starts and after each wave, so a crash or a restart in the middle does not leave a half-started plan with
// no record of it. A resume starts what never started, keeps what did, and asks before it starts again anything
// that was stopped or whose worker has gone (a repeat can do the work twice).
//
// The idea (checkpoint after every finished task and wave, kept for a short time, a side-effect step confirmed before
// a replay) is Atomic Agent's fusion run checkpoint (MIT, Copyright (c) 2026 Atomic Bot). This is Hivra's own
// version on the delegation rows: the checkpoint is stored in the app database (src-tauri/src/fanout_checkpoint.rs),
// and a task's own request id (taskRequestId) makes a repeat start a no-op for a task that already has a row.
//
// Pure: every function returns a new checkpoint. The store and the write order live in agentAppTasks.ts.
import { FANOUT_MAX_TASKS } from "./fanoutContract";

export const FANOUT_CHECKPOINT_VERSION = 1;

/** How long an unsettled fan-out is offered for a resume after its last write. */
export const FANOUT_CHECKPOINT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * pending: not started yet. starting: the start was sent and its answer not yet written (a crash here leaves it
 * unknown whether a worker exists). queued: the start answered "waiting" (the worker queue, or held for review): no row
 * yet, and its childSession names the job in the queue. started: a row exists for it. stopped: it had a row, but the row
 * was stopped or has gone, so a start again needs the person's yes. refused: it did not start and is not retried alone.
 */
export const CHECKPOINT_STATES = ["pending", "starting", "queued", "started", "stopped", "refused"] as const;
export type CheckpointState = (typeof CHECKPOINT_STATES)[number];

export type CheckpointTask = {
  name: string;
  wave: number;
  state: CheckpointState;
  /** The task's delegate input as the fan-out sent it (the same request id makes a repeat idempotent). */
  input: Record<string, unknown>;
  /**
   * The request id the last start was sent under. Absent: the plan's own id for the task. A start again after a stop
   * takes a new one, so the app records a new worker instead of reviving the stopped row (delegations.rs record).
   */
  requestId?: string;
  taskId?: string;
  childSession?: string;
  /** The start's own status (running, waiting...). */
  status?: string;
  error?: string;
};

export type FanoutCheckpoint = {
  version: typeof FANOUT_CHECKPOINT_VERSION;
  /** The delegate_tasks call's request id. */
  id: string;
  /** The orchestrating chat. */
  owner: string;
  /** The person's request, once per plan (not repeated on every task). */
  originalRequest?: string;
  /** The request's real length when it was cut to the quote budget, so a resumed brief's cut note stays honest. */
  originalRequestChars?: number;
  waves: string[][];
  tasks: CheckpointTask[];
  wavesDone: number;
  /** Bumped by every write: a copy with a lower revision never replaces a higher one. */
  revision: number;
  startedAt: number;
  updatedAt: number;
  resumes: number;
};

export type CheckpointTaskInput = { name: string; wave: number; input: Record<string, unknown> };

export function createCheckpoint(input: {
  id: string;
  owner: string;
  originalRequest?: string;
  originalRequestChars?: number;
  waves: string[][];
  tasks: CheckpointTaskInput[];
  now: number;
}): FanoutCheckpoint {
  return {
    version: FANOUT_CHECKPOINT_VERSION,
    id: input.id,
    owner: input.owner,
    ...(input.originalRequest === undefined ? {} : { originalRequest: input.originalRequest }),
    ...(input.originalRequestChars === undefined ? {} : { originalRequestChars: input.originalRequestChars }),
    waves: input.waves.map((wave) => [...wave]),
    tasks: input.tasks.map((task) => ({
      name: task.name,
      wave: task.wave,
      state: "pending",
      input: task.input,
    })),
    wavesDone: 0,
    revision: 1,
    startedAt: input.now,
    updatedAt: input.now,
    resumes: 0,
  };
}

/** The next copy: the same plan with one task changed, a higher revision and a new write time. */
function touch(cp: FanoutCheckpoint, name: string, change: Partial<CheckpointTask>, now: number): FanoutCheckpoint {
  return {
    ...cp,
    tasks: cp.tasks.map((task) => (task.name === name ? { ...task, ...change } : task)),
    revision: cp.revision + 1,
    updatedAt: now,
  };
}

/**
 * The task's start is about to be sent, under `requestId` (the plan's own id for the task when absent). A task already
 * started, queued or refused is left as it is.
 */
export function noteStarting(cp: FanoutCheckpoint, name: string, now: number, requestId?: string): FanoutCheckpoint {
  const task = cp.tasks.find((t) => t.name === name);
  if (!task || (task.state !== "pending" && task.state !== "stopped")) return cp;
  return touch(cp, name, { state: "starting", ...(requestId === undefined ? {} : { requestId }) }, now);
}

/**
 * The start answered "waiting": the task is in the worker queue (or held for review) and has no row yet. Its
 * childSession names that job, so a resume can tell it is still waiting and not gone.
 */
export function noteQueued(cp: FanoutCheckpoint, name: string, childSession: string, now: number): FanoutCheckpoint {
  const task = cp.tasks.find((t) => t.name === name);
  if (!task || task.state === "started" || task.state === "refused") return cp;
  return touch(cp, name, { state: "queued", childSession }, now);
}

/** The task's row was stopped (or has gone) and a start again waits for the person's yes. */
export function noteStopped(cp: FanoutCheckpoint, name: string, now: number): FanoutCheckpoint {
  return touch(cp, name, { state: "stopped" }, now);
}

/** The task has a row: its start answered. */
export function noteStarted(
  cp: FanoutCheckpoint,
  name: string,
  out: { taskId: string; childSession: string; status?: string },
  now: number,
): FanoutCheckpoint {
  return touch(
    cp,
    name,
    {
      state: "started",
      taskId: out.taskId,
      childSession: out.childSession,
      ...(out.status === undefined ? {} : { status: out.status }),
      error: undefined,
    },
    now,
  );
}

/** The task did not start, with the reason it was given. */
export function noteRefused(cp: FanoutCheckpoint, name: string, error: string, now: number): FanoutCheckpoint {
  return touch(cp, name, { state: "refused", error }, now);
}

/** A wave's tasks have all been sent. The count only goes up. */
export function noteWaveDone(cp: FanoutCheckpoint, wave: number, now: number): FanoutCheckpoint {
  if (wave <= cp.wavesDone) return cp;
  return { ...cp, wavesDone: wave, revision: cp.revision + 1, updatedAt: now };
}

/**
 * Every task has either started or been refused: the plan is done and its checkpoint can go. A queued task is not
 * complete: its job may still leave the queue without a row, and a resume has to say so.
 */
export function isComplete(cp: FanoutCheckpoint): boolean {
  return cp.tasks.every((task) => task.state === "started" || task.state === "refused");
}

export function isExpired(cp: FanoutCheckpoint, now: number): boolean {
  return now - cp.updatedAt > FANOUT_CHECKPOINT_RETENTION_MS;
}

/** The row the store holds for a task of the plan, by name (undefined when none). */
export type RowLookup = (name: string) => { id: string; childSession: string; state: string } | undefined;

export type ResumePlan = {
  /** Sent now: never started, and no row exists for them. */
  start: string[];
  /** Rows that exist for a task the checkpoint did not record as started: taken as started, not sent again. */
  adopt: { name: string; taskId: string; childSession: string; state: string }[];
  /** Started, and its row is running or done: left as it is. */
  kept: string[];
  /** Queued and still in the worker queue (or held for review): it starts by itself, nothing is sent. */
  waiting: string[];
  /**
   * Stopped, or started or queued with no row and no place in the queue: a repeat could do the work twice, so it
   * waits for the person's yes (a decision of its own, WP-14).
   */
  confirm: string[];
  /** Refused when first sent: not retried on a resume. */
  refused: string[];
};

/**
 * What a resume does with each task. Pure: the rows come in through `rowOf`, and `waitingOn` says whether a task's job is
 * still in the worker queue (or held for review), by name.
 */
export function planResume(
  cp: FanoutCheckpoint,
  rowOf: RowLookup,
  waitingOn: (name: string) => boolean = () => false,
): ResumePlan {
  const plan: ResumePlan = { start: [], adopt: [], kept: [], waiting: [], confirm: [], refused: [] };
  for (const task of cp.tasks) {
    const row = rowOf(task.name);
    if (task.state === "refused") {
      plan.refused.push(task.name);
      continue;
    }
    // A row the app already has for the task: adopted when the checkpoint did not see it, cancelled means it needs a yes.
    if (row && row.state !== "cancelled") {
      plan.kept.push(task.name);
      if (task.state !== "started") plan.adopt.push({ name: task.name, taskId: row.id, childSession: row.childSession, state: row.state });
      continue;
    }
    if (row) {
      plan.confirm.push(task.name);
      continue;
    }
    // No row. Still in the queue (or held for review): it starts by itself, and a second send would start it twice.
    if (waitingOn(task.name)) {
      plan.waiting.push(task.name);
      continue;
    }
    // Pending or starting, and never queued: the start was never answered, so it is sent (the same id keeps it once).
    if (task.state === "pending" || task.state === "starting") {
      plan.start.push(task.name);
      continue;
    }
    // Started, queued or stopped, and nothing is there: a repeat could do the work twice, so it waits for the yes.
    plan.confirm.push(task.name);
  }
  return plan;
}

/** Unfinished, unexpired checkpoints of one chat, newest first. */
export function listResumable(all: readonly FanoutCheckpoint[], owner: string, now: number): FanoutCheckpoint[] {
  return all
    .filter((cp) => cp.owner === owner && !isExpired(cp, now) && !isComplete(cp))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A plain-English line for First Mate: counts only, never a task id, a task name or a folder path. */
export function describeResume(plan: ResumePlan): string {
  const parts: string[] = [];
  if (plan.adopt.length + plan.kept.length)
    parts.push(`${plan.adopt.length + plan.kept.length} already started and kept as it is`);
  if (plan.waiting.length)
    parts.push(`${plan.waiting.length} waiting for a free worker, which starts by itself`);
  if (plan.start.length) parts.push(`${plan.start.length} not started yet, which is sent now`);
  if (plan.confirm.length)
    parts.push(`${plan.confirm.length} stopped or missing, which needs your yes before it starts again`);
  if (plan.refused.length) parts.push(`${plan.refused.length} refused earlier and not retried`);
  return parts.length ? `${parts.join("; ")}.` : "Nothing is left to start.";
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const NAME = /^[A-Za-z0-9_-]{1,40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

/**
 * A checkpoint as the store returned it, or null when it is damaged, from another version, or not one this app wrote.
 * A damaged checkpoint is read as none: the fan-out is then not resumed, and nothing is started on its strength.
 */
export function parseCheckpoint(value: unknown): FanoutCheckpoint | null {
  if (!isRecord(value)) return null;
  if (value.version !== FANOUT_CHECKPOINT_VERSION) return null;
  if (typeof value.id !== "string" || !ID.test(value.id)) return null;
  if (typeof value.owner !== "string" || value.owner.length === 0 || value.owner.length > 200) return null;
  const originalRequest = optionalString(value.originalRequest);
  if (originalRequest === null) return null;
  if (value.originalRequestChars !== undefined && !(Number.isInteger(value.originalRequestChars) && (value.originalRequestChars as number) >= 0))
    return null;
  const originalRequestChars = value.originalRequestChars as number | undefined;
  if (!Array.isArray(value.waves) || !value.waves.every((wave) => Array.isArray(wave) && wave.every((n) => typeof n === "string")))
    return null;
  if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > FANOUT_MAX_TASKS) return null;
  const names = new Set<string>();
  const tasks: CheckpointTask[] = [];
  for (const raw of value.tasks) {
    if (!isRecord(raw)) return null;
    if (typeof raw.name !== "string" || !NAME.test(raw.name) || names.has(raw.name)) return null;
    names.add(raw.name);
    if (!Number.isInteger(raw.wave) || (raw.wave as number) < 1) return null;
    if (!CHECKPOINT_STATES.includes(raw.state as CheckpointState)) return null;
    if (!isRecord(raw.input)) return null;
    const taskId = optionalString(raw.taskId);
    const childSession = optionalString(raw.childSession);
    const status = optionalString(raw.status);
    const error = optionalString(raw.error);
    const requestId = optionalString(raw.requestId);
    if (taskId === null || childSession === null || status === null || error === null) return null;
    if (requestId === null || (requestId !== undefined && !ID.test(requestId))) return null;
    tasks.push({
      name: raw.name,
      wave: raw.wave as number,
      state: raw.state as CheckpointState,
      input: raw.input,
      ...(requestId === undefined ? {} : { requestId }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(childSession === undefined ? {} : { childSession }),
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
    });
  }
  const nonNegative = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
  if (!nonNegative(value.wavesDone) || !nonNegative(value.resumes)) return null;
  if (!Number.isInteger(value.revision) || (value.revision as number) < 1) return null;
  if (typeof value.startedAt !== "number" || typeof value.updatedAt !== "number") return null;
  return {
    version: FANOUT_CHECKPOINT_VERSION,
    id: value.id,
    owner: value.owner,
    ...(originalRequest === undefined ? {} : { originalRequest }),
    ...(originalRequestChars === undefined ? {} : { originalRequestChars }),
    waves: (value.waves as string[][]).map((wave) => [...wave]),
    tasks,
    wavesDone: value.wavesDone as number,
    revision: value.revision as number,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    resumes: value.resumes as number,
  };
}
