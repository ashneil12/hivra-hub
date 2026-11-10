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
// - WP-176: a project or app spend limit can hold a new builder. Nothing here stops one that is already running.
// Workers never step on each other: several in one repo each get a checkout of their own (agentAppTasks.ts), across
// every chat working on the project, not only the one delegating.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WorkerPoolHost } from "../../agent-app/model/agentAppTasks";
import type { Delegation } from "./delegations";
import { FANOUT_MAX_TASKS } from "../../firstmate/model/fanoutContract";
import type { DependencyWait } from "../../firstmate/model/fanoutWaves";
import type { ProviderRateLimits } from "../../providers/model/rateLimits";
import { freshRoomAfter, limitResetAt } from "../../providers/model/accountWaterfall";
import { isOpenDelegation } from "./delegations";
import { cleanStoredDefault, readProjectWorkerDefault } from "../../crew/model/workerDefault";
import type { Pick as WorkerPick } from "../../crew/model/resolve";
import {
  DEFAULT_BUILDER_SCALE,
  HEALTH_CACHE_MS,
  HEALTH_STALE_MS,
  builderHoldNeed,
  builderLaunchAllowed,
  builderScaleFromStored,
  builderScaleIsDefault,
  builderScaleToStored,
  sanitizeBuilderScale,
  type BuilderHealth,
  type BuilderHoldNeed,
  type BuilderScale,
} from "./builderScale";
import { judgeLaunch, RAISE_LIMIT, resetSpendGate, useLiveSpendSink } from "../../usage/model/spendGate";

export type WorkerLimits = {
  workers: number;
  heavy: number;
  /** The project's own worker model (E7), when Ash chose one in the Workers dialog; else the usual Sonnet. */
  model?: string;
  /** The effort saved with that model (its own setting's value). */
  effort?: string;
  /** WP-89: the CLI that model belongs to. Absent on a row from before, which reads as Claude. */
  cli?: string;
};
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
// Kept in the app database with the queue (worker_queue.rs): every window reads the same ones, and they survive a
// restart. This window keeps a copy for the synchronous reads and reloads it on every change.

let settingsCopy: {
  limits: Record<string, Partial<WorkerLimits>>;
  heavy: Set<string>;
  /** WP-89: the worker default for every project, when one is set. */
  workerDefault?: WorkerPick;
  /** WP-161: the shared ceiling and the optional health pauses. */
  builderScale: BuilderScale;
} = { limits: {}, heavy: new Set(), builderScale: { ...DEFAULT_BUILDER_SCALE, load: { kind: "default" } } };
/**
 * Bumped on every local settings write. A refresh that started earlier read the old
 * copy; it must not put that copy back over a write that landed while it was reading.
 */
let settingsGeneration = 0;
/**
 * The settings writes this window has started and not finished. A refresh waits for
 * these before it reads, so a save that has not reached the store yet is not put back.
 */
let settingsEpoch: Promise<void> = Promise.resolve();
/**
 * Bumped when this window changes its own queue. A refresh that already read the
 * store must not put that list back over a job this window added or removed.
 */
let queueRevision = 0;
function wroteSettings(): void {
  settingsGeneration += 1;
}
function noteQueueEdit(): void {
  queueRevision += 1;
}
function noteSettingsWrite(work: Promise<unknown>): void {
  const tracked = settingsEpoch.then(() => work.then(() => undefined, () => undefined));
  settingsEpoch = tracked;
}
async function whenSettingsSettled(): Promise<void> {
  let epoch = settingsEpoch;
  await epoch;
  while (epoch !== settingsEpoch) {
    epoch = settingsEpoch;
    await epoch;
  }
}

const clampCount = (n: unknown, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_WORKERS, Math.max(1, Math.round(n))) : fallback;

export function workerLimits(project: string): WorkerLimits {
  const saved = settingsCopy.limits[project];
  // WP-161: a project with no ceiling of its own uses the shared max builders (still 6 until raised).
  const workers = clampCount(saved?.workers, builderScale().maxBuilders);
  return {
    workers,
    heavy: Math.min(workers, clampCount(saved?.heavy, Math.min(workers, DEFAULT_LIMITS.heavy))),
    ...(saved?.model ? { model: saved.model } : {}),
    ...(saved?.model && saved?.effort ? { effort: saved.effort } : {}),
    ...(saved?.model && saved?.cli ? { cli: saved.cli } : {}),
  };
}

/** Saves one project's limits (either part); heavy never exceeds workers. Returns what is now in force. */
export function setWorkerLimits(project: string, next: Partial<WorkerLimits>): WorkerLimits {
  const now = workerLimits(project);
  const workers = next.workers === undefined ? now.workers : clampCount(next.workers, now.workers);
  const heavy = Math.min(workers, next.heavy === undefined ? now.heavy : clampCount(next.heavy, now.heavy));
  wroteSettings();
  settingsCopy = {
    ...settingsCopy,
    limits: { ...settingsCopy.limits, [project]: { ...settingsCopy.limits[project], workers, heavy } },
  };
  changed();
  noteSettingsWrite(
    backend
      .setLimits(project, { workers, heavy })
      .catch((error: unknown) => console.warn("Could not save the project's worker limits", error)),
  );
  return {
    workers,
    heavy,
    ...(now.model ? { model: now.model } : {}),
    ...(now.model && now.effort ? { effort: now.effort } : {}),
    ...(now.model && now.cli ? { cli: now.cli } : {}),
  };
}

/**
 * The model a project's workers run on (E7): Ash's choice for the project, or undefined for the usual Sonnet. Read
 * synchronously while delegating, so a worker starts on it without waiting for the store.
 */
export function projectWorkerModel(project: string): { model: string; effort?: string } | undefined {
  const saved = settingsCopy.limits[project];
  if (!saved?.model) return undefined;
  // A model for another CLI is not a Claude ladder choice. The full default is projectWorkerDefault.
  if (saved.cli && saved.cli !== "claude") return undefined;
  return { model: saved.model, ...(saved.effort ? { effort: saved.effort } : {}) };
}

/** WP-89: the project's worker default, including a CLI. An old row with no CLI reads as Claude. */
export function projectWorkerDefault(project: string): WorkerPick | undefined {
  return readProjectWorkerDefault(settingsCopy.limits[project]);
}

/** WP-89: the worker default for every project, when one is set. */
export function systemWorkerDefault(): WorkerPick | undefined {
  return cleanStoredDefault(settingsCopy.workerDefault);
}

/** WP-161: the shared max builders and the optional pauses. A bad value falls back, it is not thrown away whole. */
export function builderScale(): BuilderScale {
  return sanitizeBuilderScale(settingsCopy.builderScale);
}

/**
 * Saves the shared scale. The default is not stored. This does not stop a builder that is already running:
 * the saved value has no list of builders to stop.
 */
export function setBuilderScale(next: BuilderScale): BuilderScale {
  const clean = sanitizeBuilderScale(next);
  wroteSettings();
  settingsCopy = { ...settingsCopy, builderScale: clean };
  changed();
  noteSettingsWrite(
    (backend.setBuilderScale?.(clean) ?? Promise.resolve(null)).catch((error: unknown) =>
      console.warn("Could not save the builder scale", error),
    ),
  );
  return clean;
}

/** Saves (or clears, with undefined) the worker default for every project. A value that isn't usable is dropped. */
export function setSystemWorkerDefault(choice: WorkerPick | undefined): void {
  const clean = cleanStoredDefault(choice);
  wroteSettings();
  settingsCopy = { ...settingsCopy, workerDefault: clean };
  changed();
  noteSettingsWrite(
    backend
      .setWorkerDefault(clean)
      .catch((error: unknown) => console.warn("Could not save the worker default", error)),
  );
}

/** Saves (or clears, with undefined) one project's own worker model; its limits are left as they are. */
export function setProjectWorkerModel(
  project: string,
  choice: { cli?: string; model: string; effort?: string } | undefined,
): void {
  const saved = settingsCopy.limits[project] ?? {};
  wroteSettings();
  settingsCopy = {
    ...settingsCopy,
    limits: {
      ...settingsCopy.limits,
      [project]: choice
        ? { ...saved, model: choice.model, effort: choice.effort, cli: choice.cli }
        : { ...saved, model: undefined, effort: undefined, cli: undefined },
    },
  };
  changed();
  noteSettingsWrite(
    backend
      .setModel(project, choice)
      .catch((error: unknown) => console.warn("Could not save the project's worker model", error)),
  );
}

/**
 * Every project whose limits Ash changed from the defaults (A10: they travel with an export). Read from this window's
 * copy, which is what the app itself uses; a project left at the defaults isn't listed, so an import never writes
 * limits nobody chose.
 */
export function savedWorkerLimits(): Record<string, WorkerLimits> {
  return Object.fromEntries(Object.keys(settingsCopy.limits).sort().map((project) => [project, workerLimits(project)]));
}

/** "Hivra runs up to 6 workers at once, 2 of them on heavy tests." */
export function limitsLine(projectName: string, limits: WorkerLimits): string {
  return `${projectName} runs up to ${limits.workers} ${limits.workers === 1 ? "worker" : "workers"} at once, ${limits.heavy} of them on heavy tests.`;
}

// ---- heavy workers -----------------------------------------------------------------------------------------------

/** The Lead said this worker's job is heavy (it runs full test suites, e2e or builds). */
export function markHeavy(childSession: string): void {
  if (settingsCopy.heavy.has(childSession)) return;
  wroteSettings();
  settingsCopy = { ...settingsCopy, heavy: new Set([...settingsCopy.heavy, childSession]) };
  changed();
  noteSettingsWrite(
    backend.markHeavy(childSession).catch((error: unknown) => console.warn("Could not note a heavy worker", error)),
  );
}
export function isHeavy(childSession: string): boolean {
  return settingsCopy.heavy.has(childSession);
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
export type ProviderRoom = { room: true } | { room: false; provider: string; until?: number; why?: "limited" | "not-signed-in" };

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
  /** r87: the files or folders it will change (declared or named in its brief); one that shares them with running work waits. */
  files?: readonly string[];
  /** A window is starting it until then (its lease); free again after, in its place. From the store only. */
  claimedUntil?: number;
};

/**
 * Where the queue lives: the app database (src-tauri/src/worker_queue.rs), so it survives a restart, every window
 * shares it, and it is the one source of truth. This window keeps a copy for the synchronous reads (the gate, the
 * cards) and reloads it whenever any window changes the queue.
 */
export type WorkerQueueBackend = {
  list(): Promise<QueuedWorker[]>;
  /** True when it was added (one already waiting keeps its place). */
  add(job: QueuedWorker): Promise<boolean>;
  /** True only for the caller that removed it: of two windows starting the same job, one does. */
  take(id: string): Promise<boolean>;
  /** A queue an older build kept in local storage, imported once; how many were added. */
  importLocal(jobs: QueuedWorker[]): Promise<number>;
  /** Hold a job while this window starts it (a lease, LEASE_MS); true when this call got it. */
  claim(id: string, by: string): Promise<boolean>;
  /** The claimed job started: out of the queue (only the claimant's finish counts). */
  finish(id: string, by: string): Promise<boolean>;
  /** Each project's limits, the workers marked heavy, the system worker default, and the builder scale when one is set. */
  settings(): Promise<{
    limits: Record<string, Partial<WorkerLimits>>;
    heavy: string[];
    workerDefault?: WorkerPick;
    /** WP-161. Absent means the defaults (6, load at 1.6 times the cores, memory off, disk below 30 GB). */
    builderScale?: unknown;
  }>;
  setLimits(project: string, limits: WorkerLimits): Promise<WorkerLimits>;
  /** The project's own worker model (E7); undefined clears it. `cli` is the WP-89 CLI, absent on an old Claude row. */
  setModel(
    project: string,
    choice: { cli?: string; model: string; effort?: string } | undefined,
  ): Promise<unknown>;
  /** WP-89: the worker default for every project. Undefined clears it. */
  setWorkerDefault(choice: WorkerPick | undefined): Promise<unknown>;
  /** WP-161: the shared ceiling and pauses. Optional so a stand-in from before this field still loads. */
  setBuilderScale?(scale: BuilderScale): Promise<unknown>;
  markHeavy(child: string): Promise<boolean>;
  /** Limits and the heavy list an older build kept in local storage, imported once. */
  importLocalSettings(limits: Record<string, Partial<WorkerLimits>>, heavy: string[]): Promise<boolean>;
  /** Any window changed the queue. */
  subscribe?(onChange: () => void): () => void;
};

/** The app's store. */
export const tauriWorkerQueue: WorkerQueueBackend = {
  list: () => invoke<QueuedWorker[]>("worker_queue_list"),
  add: (job) => invoke<boolean>("worker_queue_add", { job }),
  take: (id) => invoke<boolean>("worker_queue_take", { id }),
  importLocal: (jobs) => invoke<number>("worker_queue_import_local", { jobs }),
  claim: (id, by) => invoke<boolean>("worker_queue_claim", { id, by }),
  finish: (id, by) => invoke<boolean>("worker_queue_finish", { id, by }),
  settings: () => invoke("worker_settings"),
  setLimits: (project, limits) =>
    invoke<WorkerLimits>("worker_limits_set", { project, workers: limits.workers, heavy: limits.heavy }),
  setModel: (project, choice) =>
    invoke("worker_model_set", {
      project,
      model: choice?.model ?? null,
      effort: choice?.effort ?? null,
      cli: choice?.cli ?? null,
    }),
  setWorkerDefault: (choice) => invoke("worker_default_set", { value: choice ?? null }),
  // WP-161: null clears a scale that is back to the defaults.
  setBuilderScale: (scale) => invoke("builder_scale_set", { value: builderScaleToStored(scale) }),
  markHeavy: (child) => invoke<boolean>("worker_heavy_mark", { child }),
  importLocalSettings: (limits, heavy) => invoke<boolean>("worker_settings_import_local", { limits, heavy }),
  subscribe: (onChange) => {
    let off: (() => void) | undefined;
    let gone = false;
    void listen(WORKER_QUEUE_CHANGED, onChange)
      .then((unlisten) => (gone ? unlisten() : (off = unlisten)))
      .catch(() => undefined);
    return () => {
      gone = true;
      off?.();
    };
  },
};
export const WORKER_QUEUE_CHANGED = "worker-queue-changed";

/** How long a window has to start a job it claimed (worker_queue.rs LEASE_MS). */
export const LEASE_MS = 2 * 60_000;

type StoredJob = QueuedWorker & { claimedBy?: string };
/** A store in memory with worker_queue.rs's rules (tests, and a build without the app's database). */
export function memoryWorkerQueue(
  initial: QueuedWorker[] = [],
  now: () => number = Date.now,
): WorkerQueueBackend & {
  jobs: StoredJob[];
  imported: boolean;
  limits: Record<string, WorkerLimits>;
  heavy: string[];
  importedSettings: boolean;
  /** What the app does on launch: every claim is free again. */
  releaseAll(): void;
} {
  const notify = () => {
    for (const l of store.listeners) l();
  };
  const store = {
    jobs: initial.map((job) => ({ ...job })) as StoredJob[],
    imported: false,
    limits: {} as Record<string, WorkerLimits>,
    heavy: [] as string[],
    workerDefault: undefined as WorkerPick | undefined,
    builderScale: { ...DEFAULT_BUILDER_SCALE, load: { kind: "default" as const } } as BuilderScale,
    importedSettings: false,
    listeners: new Set<() => void>(),
    list: async () =>
      store.jobs.map(({ claimedBy: _by, claimedUntil, ...job }) => ({
        ...job,
        ...(claimedUntil && claimedUntil > now() ? { claimedUntil } : {}),
      })),
    add: async (job: QueuedWorker) => {
      if (store.jobs.some((q) => q.id === job.id)) return false;
      const { claimedUntil: _c, ...plain } = job;
      store.jobs.push(plain);
      notify();
      return true;
    },
    take: async (id: string) => {
      const before = store.jobs.length;
      store.jobs = store.jobs.filter((q) => q.id !== id);
      if (store.jobs.length === before) return false;
      notify();
      return true;
    },
    claim: async (id: string, by: string) => {
      const job = store.jobs.find((q) => q.id === id);
      if (!job || (job.claimedUntil && job.claimedUntil > now())) return false;
      job.claimedUntil = now() + LEASE_MS;
      job.claimedBy = by;
      notify();
      return true;
    },
    finish: async (id: string, by: string) => {
      const before = store.jobs.length;
      store.jobs = store.jobs.filter((q) => !(q.id === id && q.claimedBy === by));
      if (store.jobs.length === before) return false;
      notify();
      return true;
    },
    releaseAll: () => {
      for (const job of store.jobs) {
        delete job.claimedUntil;
        delete job.claimedBy;
      }
    },
    importLocal: async (jobs: QueuedWorker[]) => {
      if (store.imported) return 0;
      store.imported = true;
      let added = 0;
      for (const job of [...jobs].sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0)))
        if (job && typeof job.id === "string" && job.id && (await store.add(job))) added++;
      return added;
    },
    settings: async () => ({
      limits: { ...store.limits },
      heavy: [...store.heavy],
      ...(store.workerDefault ? { workerDefault: store.workerDefault } : {}),
      ...(builderScaleIsDefault(store.builderScale) ? {} : { builderScale: builderScaleToStored(store.builderScale) }),
    }),
    setLimits: async (project: string, limits: WorkerLimits) => {
      const workers = clampCount(limits.workers, DEFAULT_LIMITS.workers);
      store.limits[project] = {
        ...store.limits[project],
        workers,
        heavy: Math.min(workers, clampCount(limits.heavy, DEFAULT_LIMITS.heavy)),
      };
      notify();
      return store.limits[project];
    },
    setModel: async (project: string, choice: { cli?: string; model: string; effort?: string } | undefined) => {
      const prev = store.limits[project];
      store.limits[project] = {
        ...prev,
        model: choice?.model,
        effort: choice?.effort,
        cli: choice?.cli,
      };
      notify();
      return store.limits[project];
    },
    setWorkerDefault: async (choice: WorkerPick | undefined) => {
      store.workerDefault = choice;
      notify();
      return choice ?? null;
    },
    setBuilderScale: async (scale: BuilderScale) => {
      store.builderScale = sanitizeBuilderScale(scale);
      notify();
      return builderScaleToStored(store.builderScale);
    },
    markHeavy: async (child: string) => {
      if (store.heavy.includes(child)) return false;
      store.heavy = [...store.heavy, child].slice(-500);
      notify();
      return true;
    },
    importLocalSettings: async (limits: Record<string, Partial<WorkerLimits>>, heavy: string[]) => {
      if (store.importedSettings) return false;
      store.importedSettings = true;
      for (const [project, value] of Object.entries(limits ?? {}))
        if (!store.limits[project] && typeof value?.workers === "number")
          await store.setLimits(project, { workers: value.workers, heavy: value.heavy ?? DEFAULT_LIMITS.heavy });
      for (const child of heavy ?? []) if (typeof child === "string") await store.markHeavy(child);
      return true;
    },
    subscribe: (onChange: () => void) => {
      store.listeners.add(onChange);
      return () => store.listeners.delete(onChange);
    },
  };
  return store;
}

/** This window, as a claimant: a claim it left behind is never mistaken for another window's. */
const windowId = `window-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

let backend: WorkerQueueBackend = memoryWorkerQueue();
let unsubscribe: (() => void) | undefined;
let copy: QueuedWorker[] = [];
let loading: Promise<void> | undefined;

/** Use this store from now on, and load it (App.tsx: the app's database). */
export function setWorkerQueueBackend(next: WorkerQueueBackend): Promise<void> {
  unsubscribe?.();
  backend = next;
  noteQueueEdit();
  copy = [];
  wroteSettings();
  settingsCopy = { limits: {}, heavy: new Set(), builderScale: { ...DEFAULT_BUILDER_SCALE, load: { kind: "default" } } };
  loading = undefined;
  unsubscribe = next.subscribe?.(() => void refreshWorkerQueue());
  return loadWorkerQueue();
}

/**
 * Loads the queue: first, once, whatever an older build left in this window's local storage (taken out of local
 * storage once the store has it), then the store's own list.
 */
export function loadWorkerQueue(): Promise<void> {
  loading ??= (async () => {
    const left = read<QueuedWorker[]>(QUEUE_KEY, []);
    if (Array.isArray(left) && left.length) {
      try {
        await backend.importLocal(left.filter((q) => q && typeof q.id === "string"));
        localStorage.removeItem(QUEUE_KEY);
      } catch (error) {
        console.warn("Could not move the waiting workers into the app's store yet", error);
      }
    } else if (Array.isArray(left)) {
      try {
        localStorage.removeItem(QUEUE_KEY);
      } catch {
        /* none */
      }
    }
    const limits = read<Record<string, Partial<WorkerLimits>> | null>(LIMITS_KEY, null);
    const heavy = read<string[] | null>(HEAVY_KEY, null);
    if (limits || heavy) {
      try {
        await backend.importLocalSettings(
          limits && typeof limits === "object" ? limits : {},
          Array.isArray(heavy) ? heavy.filter((id) => typeof id === "string") : [],
        );
        localStorage.removeItem(LIMITS_KEY);
        localStorage.removeItem(HEAVY_KEY);
      } catch (error) {
        console.warn("Could not move the worker limits into the app's store yet", error);
      }
    }
    await refreshWorkerQueue();
  })();
  return loading;
}

/** Read the store again (another window changed it). */
export async function refreshWorkerQueue(): Promise<void> {
  const seen = settingsGeneration;
  try {
    // A save bumps the generation before the store has it. Wait, then read both together.
    await whenSettingsSettled();
    const revision = queueRevision;
    const [jobs, settings] = await Promise.all([backend.list(), backend.settings()]);
    // This window added or removed a job while that list was being read. The list is
    // already behind the local queue, so keep the local one. The edit's own refresh reads again.
    if (revision !== queueRevision) {
      changed();
      return;
    }
    copy = jobs;
    // A save landed while this read was in flight. Keep that save; this copy is older.
    if (seen !== settingsGeneration) {
      changed();
      return;
    }
    settingsCopy = {
      limits: settings.limits ?? {},
      heavy: new Set(settings.heavy ?? []),
      ...(settings.workerDefault ? { workerDefault: settings.workerDefault } : {}),
      // A row saved before the disk pause was on by default reads as the new default (builderScaleFromStored).
      builderScale: builderScaleFromStored(settings.builderScale),
    };
  } catch (error) {
    console.warn("Could not read the waiting workers", error);
    return;
  }
  changed();
}

/** Hold a job while this window starts it. */
export function claimWorker(id: string): Promise<boolean> {
  return backend.claim(id, windowId).catch(() => false);
}
/**
 * The start was refused because the owner is already at the fan-out cap. Drop the lease and put the job back, so the
 * next look can start it. Taking it and adding it again clears the claim (add keeps no lease) without a new command.
 */
async function releaseForRetry(job: QueuedWorker): Promise<void> {
  const { claimedUntil: _claimed, ...plain } = job;
  noteQueueEdit();
  copy = copy.some((queued) => queued.id === job.id)
    ? copy.map((queued) => (queued.id === job.id ? plain : queued))
    : [...copy, plain];
  changed();
  const removed = await backend.take(job.id).catch(() => false);
  if (!removed) {
    await refreshWorkerQueue();
    return;
  }
  await backend.add(plain).catch((error: unknown) => console.warn("Could not keep a waiting worker", error));
  noteQueueEdit();
  await refreshWorkerQueue();
}

/** It started (or its start was refused): out of the queue, if this window still holds it. */
export function finishWorker(id: string): Promise<boolean> {
  if (copy.some((q) => q.id === id)) {
    noteQueueEdit();
    copy = copy.filter((q) => q.id !== id);
    changed();
  }
  return backend.finish(id, windowId).catch(() => false);
}
/** Being started by some window right now (its lease hasn't run out). */
export function isClaimed(job: QueuedWorker, now = Date.now()): boolean {
  return !!job.claimedUntil && job.claimedUntil > now;
}

export function queuedWorkers(): QueuedWorker[] {
  return copy;
}
export function queuedWorker(id: string): QueuedWorker | undefined {
  return copy.find((q) => q.id === id);
}
/** Waits in order; asking again with the same request keeps its place. */
export function enqueueWorker(job: QueuedWorker): Promise<void> {
  if (!copy.some((q) => q.id === job.id)) {
    noteQueueEdit();
    copy = [...copy, job];
    changed();
  }
  return backend
    .add(job)
    .then(() => refreshWorkerQueue())
    .catch((error: unknown) => console.warn("Could not keep a waiting worker", error));
}
/** Out of the queue (it started, or was taken back). Resolves true when this call removed it from the store. */
export function dequeueWorker(id: string): Promise<boolean> {
  if (copy.some((q) => q.id === id)) {
    noteQueueEdit();
    copy = copy.filter((q) => q.id !== id);
    changed();
  }
  return backend.take(id).catch(() => false);
}

// ---- deciding ----------------------------------------------------------------------------------------------------

/**
 * WP-171: `requires` waits for the tasks of its fan-out that provide what it needs; `held` is that wait when one of
 * them failed; `fanout` is the owner's own cap (a first mate runs at most FANOUT_MAX_TASKS at once).
 */
export type WaitReason = "workers" | "heavy" | "limit" | "files" | "health" | "spend" | "requires" | "held" | "fanout";
export type Admission = { start: true; line?: string } | { start: false; reason: WaitReason; line: string };

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function waitLine(reason: WaitReason, projectName: string, limits: WorkerLimits, room?: ProviderRoom): string {
  if (reason === "limit" && room && !room.room) {
    // Not signed in is not a limit: no reset is coming, so waiting would never end. Say what actually unblocks it.
    if (room.why === "not-signed-in")
      return `${room.provider} isn't signed in, so no worker can start. Sign it in from Settings, then it goes.`;
    return `Waiting for ${room.provider}'s limit to reset${room.until ? ` at ${clock(room.until)}` : ""}; it starts by itself then.`;
  }
  if (reason === "heavy")
    return `Waiting for a free worker: ${projectName} runs ${limits.heavy} heavy test ${limits.heavy === 1 ? "job" : "jobs"} at once.`;
  return limits.workers === 1
    ? `Waiting for a free worker: ${projectName} runs one at a time.`
    : `Waiting for a free worker: all ${limits.workers} of ${projectName}'s are busy.`;
}

export type AdmitInput = {
  id: string;
  project: string;
  projectName: string;
  heavy: boolean;
  harness: string;
  /** r87: the files or folders it will change, when known. */
  files?: readonly string[];
  /** WP-171: its fan-out link (firstmate/model/fanoutWaves.ts), when it is one task of a contract. Opaque here. */
  fanout?: unknown;
  /** The chat that asked. When set, its open tasks count toward the fan-out cap, and it is the one a spend warning wakes. Absent: neither applies. */
  ownerSession?: string;
};

// ---- r87: two jobs never change the same files at once ------------------------------------------------------------
// c02 r86 run 3: the shared-type worker and the last-week worker both changed packages/ui/src/App.tsx at once; landing
// settled the clash after the fact. Now a job whose files are known (delegate_task `files`, or paths its brief names)
// waits while a running job in the same project changes any of them, and starts by itself once that one has landed,
// from the project with that work in (r86 step 2b).

/** The files each running worker is known to change, from its start. */
const touching = new Map<string, Set<string>>();
export function declareFiles(childSession: string, files: readonly string[]): void {
  if (!files.length) return;
  const set = touching.get(childSession) ?? new Set<string>();
  for (const file of files) set.add(normalFile(file));
  touching.set(childSession, set);
}
export function filesOf(childSession: string): readonly string[] {
  return [...(touching.get(childSession) ?? [])];
}
export function forgetFiles(): void {
  touching.clear();
}

const normalFile = (file: string) => file.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
/** One names the other, or a folder holding it. */
export function sameFiles(a: string, b: string): boolean {
  const [x, y] = [normalFile(a), normalFile(b)];
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

const PATHISH = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6}|[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|rs|py|go|rb|md|json|css|scss|html|vue|svelte|toml|ya?ml))(?=[\s`'",.:;)\]]|$)/g;
/** Files a brief names ("packages/ui/src/App.tsx", "README.md"); a URL or a bare word is not one. */
export function filesNamed(text: string): string[] {
  const found = new Set<string>();
  // "Do not touch README.md" names a file it won't change; a <worker_rules> block is the hub's, not the job's.
  const own = text
    .replace(/<worker_rules>[\s\S]*?(<\/worker_rules>|$)/g, " ")
    .split(/(?<=[.!?\n])\s+/)
    .filter((sentence) => !/\b(do not|don't|never|leave)\b|^\s*not\b/i.test(sentence))
    .join(" ");
  for (const match of own.matchAll(PATHISH)) {
    const file = normalFile(match[1]);
    if (!/^https?:/i.test(file) && !/^\d+(\.\d+)+$/.test(file)) found.add(file);
  }
  return [...found];
}

// The Lead briefs within two minutes, before anyone has read the code, so a brief rarely names a file (c02 r87 run 1:
// none of five did, and two UI jobs met in packages/ui/src/App.tsx again). Its area does: "Change only the API server",
// "UI only", "on the board". One job per area runs at a time in a project; the next waits for it to land.
const AREAS: readonly (readonly [string, RegExp])[] = [
  ["ui", /\b(ui|board|front[- ]?end|screen|component|layout|css|button)s?\b/i],
  ["api", /\b(api|endpoint|route|server|handler|backend)s?\b/i],
  ["docs", /\b(readme|docs?|documentation|todo|backlog|changelog)\b/i],
];
export const AREA_PREFIX = "area:";
const AREA_WORDS: Record<string, string> = { ui: "the UI", api: "the API", docs: "the docs" };

/** A brief's areas: from its title and its "only" lines when they name one, else from what it asks (not what it rules out, nor Ash's quoted words). */
export function areasNamed(title: string, brief: string): string[] {
  const own = brief
    .replace(/<worker_rules>[\s\S]*?(<\/worker_rules>|$)/g, " ")
    .replace(/"[^"]*"|“[^”]*”/g, " ")
    .split(/(?<=[.!?\n])\s+/)
    .filter((sentence) => !/\b(do not|don't|never|leave|another job|other job)\b|^\s*not\b/i.test(sentence));
  const of = (texts: string[]) => AREAS.filter(([, word]) => texts.some((t) => word.test(t))).map(([area]) => area);
  const pinned = of([title, ...own.filter((sentence) => /\bonly\b/i.test(sentence))]);
  return (pinned.length ? pinned : of(own)).map((area) => `${AREA_PREFIX}${area}`);
}

/** The running job in the project that changes one of these files, and the file. */
function sharedWith(
  job: Pick<AdmitInput, "id" | "project" | "files">,
  rows: AdmitContext["rows"],
  starting: readonly Pick<QueuedWorker, "id" | "project" | "files" | "title">[] = [],
): { title: string; file: string } | undefined {
  if (!job.files?.length) return undefined;
  for (const row of rows) {
    if (row.childSession === job.id || (row.project ?? "") !== job.project || row.follow === "lead") continue;
    if (row.state !== "running" && row.state !== "question") continue;
    for (const theirs of filesOf(row.childSession))
      for (const mine of job.files) if (sameFiles(mine, theirs)) return { title: row.title ?? "another job", file: mine };
  }
  for (const other of starting) {
    if (other.id === job.id || other.project !== job.project) continue;
    for (const theirs of other.files ?? []) for (const mine of job.files) if (sameFiles(mine, theirs)) return { title: other.title, file: mine };
  }
  return undefined;
}

export function filesWaitLine(shared: { title: string; file: string }): string {
  const what = shared.file.startsWith(AREA_PREFIX)
    ? (AREA_WORDS[shared.file.slice(AREA_PREFIX.length)] ?? shared.file.slice(AREA_PREFIX.length))
    : shared.file;
  return `Waiting for "${shared.title.split("\n")[0].slice(0, 60)}" to land: both change ${what}. It starts by itself then, from the project with that work in.`;
}

export type AdmitContext = {
  rows: readonly (Pick<Delegation, "project" | "state" | "childSession" | "follow"> &
    Partial<Pick<Delegation, "title" | "ownerSession">>)[];
  room: (harness: string) => ProviderRoom;
  limits?: (project: string) => WorkerLimits;
  heavy?: (childSession: string) => boolean;
  /** What waits already (queue order); defaults to the saved queue. */
  queue?: readonly QueuedWorker[];
  /**
   * WP-171: what a task of a fan-out still waits for, from the rows (firstmate/model/fanoutWaves.ts dependencyVerdict);
   * undefined when everything it needs is delivered. Absent: no task waits for another.
   */
  dependency?: (job: { id: string; fanout: unknown }) => DependencyWait | undefined;
};

/** The wait a job's dependencies put on it now, or undefined (it needs nothing, or has it). */
function dependencyWait(job: { id: string; fanout?: unknown }, ctx: AdmitContext): DependencyWait | undefined {
  return job.fanout === undefined ? undefined : ctx.dependency?.({ id: job.id, fanout: job.fanout });
}

/**
 * WP-171: the dependency the waiting card reads. The pump gets its own copy on each call. The card does not, so the
 * window that owns the queue publishes the same function here. Absent, a card cannot tell a held task from a free worker.
 */
let queueDependency: AdmitContext["dependency"] | undefined;

/** Publish (or clear) the dependency check the waiting cards read. */
export function setQueueDependency(next: AdmitContext["dependency"] | undefined): void {
  queueDependency = next;
}

/** Why this queued task waits on another task, or undefined when it does not. */
export function taskWait(job: QueuedWorker): DependencyWait | undefined {
  return dependencyWait(
    { id: job.id, fanout: queuedFanout(job) },
    { rows: [], room: () => ({ room: true }), dependency: queueDependency },
  );
}

/** A queued job's fan-out link, kept in its stored delegate input. */
const queuedFanout = (job: QueuedWorker): unknown => job.input?.fanout;

/** The latest health sample. A launch with none yet is allowed. Reset drops it. */
let healthNow: BuilderHealth | undefined;
let healthEpoch = 0;
let healthInflight: Promise<void> | undefined;
let healthTimeoutMs = 3_000;
const defaultHealthReader = (): Promise<unknown> => invoke("builder_health");
let healthReader: () => Promise<unknown> = defaultHealthReader;

/** The sample a launch reads. Undefined until a read has landed. */
export function builderHealth(): BuilderHealth | undefined {
  return healthNow;
}

/**
 * WP-161: the Needs you line for builders the disk pause is holding, or null. It reads the same sample and the same
 * saved pause the launch gate reads, and the queue, so it appears when a builder waits and clears when the disk recovers.
 */
export function builderHold(): BuilderHoldNeed | null {
  return builderHoldNeed(queuedWorkers().length, healthNow, builderScale());
}

/** WP-176: one Needs you line when a queued builder is over a spend limit. Running work is not in this. */
export function spendHold(): { id: "builders-spend"; text: string; action: typeof RAISE_LIMIT } | null {
  for (const job of queuedWorkers()) {
    const spend = judgeLaunch({ project: job.project, harness: job.harness, ownerSession: job.ownerSession });
    if (spend.status === "over" && spend.reason.trim()) {
      return { id: "builders-spend", text: spend.reason.trim(), action: RAISE_LIMIT };
    }
  }
  return null;
}

/** Tests stand in for the command. `null` puts the command back. */
export function setBuilderHealthReader(reader: (() => Promise<unknown>) | null): void {
  healthReader = reader ?? defaultHealthReader;
}

/** Tests shorten the wait. `null` puts the 3s wait back. */
export function setBuilderHealthTimeout(ms: number | null): void {
  healthTimeoutMs = ms == null || !Number.isFinite(ms) || ms < 1 ? 3_000 : ms;
}

function finiteHealth(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A command payload. Only the known numbers are kept. Anything else is missing, not a pause. */
function healthFromWire(raw: unknown, now: number): BuilderHealth | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const cores = finiteHealth(row.cores);
  const readAt = finiteHealth(row.readAt);
  return {
    load1: finiteHealth(row.load1),
    cores: cores != null && cores >= 1 ? Math.round(cores) : null,
    freeMemoryGb: finiteHealth(row.freeMemoryGb),
    freeDiskGb: finiteHealth(row.freeDiskGb),
    readAt: readAt ?? now,
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The health reading timed out")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("The health reading failed"));
      },
    );
  });
}

async function refreshBuilderHealthOnce(): Promise<void> {
  const epoch = healthEpoch;
  const held = healthNow;
  const now = Date.now();
  if (held && held.now == null && typeof held.readAt === "number" && now - held.readAt < HEALTH_CACHE_MS) return;
  let sample: BuilderHealth | null = null;
  try {
    sample = healthFromWire(await withTimeout(healthReader(), healthTimeoutMs), now);
  } catch (error) {
    sample = null;
    const internals = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (internals) console.warn("Could not read builder health", error);
  }
  if (epoch !== healthEpoch) return;
  if (sample) {
    setBuilderHealth(sample);
    return;
  }
  // A timeout is not a pause. Keep a fresh sample, drop one old enough that it must not keep pausing.
  if (held?.now != null) return;
  if (held && typeof held.readAt === "number" && now - held.readAt <= HEALTH_STALE_MS) return;
  setBuilderHealth(null);
}

/** Reads health unless the sample is still fresh. One read at a time. Never throws. */
export function refreshBuilderHealth(): Promise<void> {
  if (healthInflight) return healthInflight;
  healthInflight = refreshBuilderHealthOnce().finally(() => {
    healthInflight = undefined;
  });
  return healthInflight;
}

/**
 * The sample the launch gate reads. A sample that is older than the one already held is ignored,
 * so a late read cannot put a stale pause back. `null` clears it.
 */
export function setBuilderHealth(next: BuilderHealth | null | undefined): void {
  if (next == null) {
    if (healthNow === undefined) return;
    healthNow = undefined;
    changed();
    return;
  }
  const prevAt = healthNow?.readAt;
  const nextAt = next.readAt;
  if (
    typeof prevAt === "number" &&
    Number.isFinite(prevAt) &&
    typeof nextAt === "number" &&
    Number.isFinite(nextAt) &&
    nextAt < prevAt
  ) {
    return;
  }
  healthNow = next;
  changed();
}

function decide(job: AdmitInput, load: ProjectLoad, limits: WorkerLimits, room: ProviderRoom): Admission {
  if (load.running >= limits.workers)
    return { start: false, reason: "workers", line: waitLine("workers", job.projectName, limits) };
  if (job.heavy && load.heavy >= limits.heavy)
    return { start: false, reason: "heavy", line: waitLine("heavy", job.projectName, limits) };
  if (!room.room) return { start: false, reason: "limit", line: waitLine("limit", job.projectName, limits, room) };
  // WP-161: health is after the counts and the provider. Raising the ceiling does not skip it.
  // WP-176: the spend limit is the same gate. A disk or load pause wins. Over holds a new launch only.
  const spend = judgeLaunch({ project: job.project, harness: job.harness, ownerSession: job.ownerSession });
  const gate = builderLaunchAllowed(healthNow, builderScale(), spend);
  if (!gate.ok) {
    const spendRefusal = spend.status === "over" && gate.reason === spend.reason;
    return { start: false, reason: spendRefusal ? "spend" : "health", line: gate.reason };
  }
  if (spend.status === "unmeasured" && spend.reason.trim()) return { start: true, line: spend.reason.trim() };
  return { start: true };
}

/** Open tasks of one owner: running or asking, and not a followed brief (the same rows check_fanout counts). */
function ownerOpen(owner: string, rows: AdmitContext["rows"]): number {
  let n = 0;
  for (const row of rows) {
    if (row.ownerSession !== owner || row.follow) continue;
    if (row.state !== "running" && row.state !== "question") continue;
    n += 1;
  }
  return n;
}

/** The line for a task that would put its owner over the fan-out cap. `open` is how many already count. */
export function fanoutWaitLine(open: number): string {
  return `Waiting: you already have ${open} tasks running, the most one first mate runs at once (${FANOUT_MAX_TASKS}). It starts by itself when one finishes.`;
}

/** One line for the owner when a waiting task is dropped instead of started. Names the task. */
export function droppedTaskLine(job: Pick<QueuedWorker, "title">, error: unknown): string {
  const why = error instanceof Error ? error.message : String(error);
  const name = job.title.trim() || "A waiting task";
  return `"${name}" was dropped before it could start: ${why}`;
}

/** One line for the owner when a task becomes held. Names the task, then the reason the queue already computed. */
export function heldTaskLine(job: Pick<QueuedWorker, "title">, line: string): string {
  const name = job.title.trim() || "A waiting task";
  return `"${name}" is waiting for another task. ${line}`;
}

/** The rust cap refusal (firstmate check_fanout). A task that hits it waits; it is not a final failure. */
function capRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("the most one first mate runs at once");
}

/**
 * How many of this owner's tasks already count against the cap, before `job` would start: open rows, jobs ahead of
 * it that would start now, and any job another window has claimed. A job with no owner is not capped.
 */
function fanoutPressure(job: { id: string; ownerSession?: string }, ctx: AdmitContext): number | undefined {
  if (!job.ownerSession) return undefined;
  const queue = ctx.queue ?? queuedWorkers();
  const at = queue.findIndex((queued) => queued.id === job.id);
  const ahead = at < 0 ? queue : queue.slice(0, at);
  const starters = nextWorkers({ ...ctx, queue: ahead });
  let n = ownerOpen(job.ownerSession, ctx.rows);
  const counted = new Set<string>();
  for (const queued of starters) {
    if (queued.ownerSession !== job.ownerSession || counted.has(queued.id)) continue;
    counted.add(queued.id);
    n += 1;
  }
  for (const queued of queue) {
    if (queued.id === job.id || queued.ownerSession !== job.ownerSession || !isClaimed(queued) || counted.has(queued.id))
      continue;
    counted.add(queued.id);
    n += 1;
  }
  return n;
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
  // WP-171: a task that waits for a provider holds no seat, so it never holds up work that needs nothing.
  const ahead = (ctx.queue ?? queuedWorkers()).filter(
    (q) =>
      q.project === job.project &&
      q.id !== job.id &&
      !(q.heavy && heavyFull) &&
      !dependencyWait({ id: q.id, fanout: queuedFanout(q) }, ctx),
  );
  const needed = dependencyWait(job, ctx);
  if (needed) return { start: false, reason: needed.reason, line: needed.line };
  const shared = sharedWith(job, ctx.rows, ahead);
  if (shared) return { start: false, reason: "files", line: filesWaitLine(shared) };
  // WP-171: a task of a fan-out waits at the owner's cap. An ordinary worker does not: the project's own limit decides.
  if (job.fanout !== undefined) {
    const pressure = fanoutPressure(job, ctx);
    if (pressure !== undefined && pressure >= FANOUT_MAX_TASKS)
      return { start: false, reason: "fanout", line: fanoutWaitLine(pressure) };
  }
  return decide(job, { running: load.running + ahead.length, heavy: load.heavy + ahead.filter((q) => q.heavy).length }, limits, room);
}

/** The waiting workers that can start now, in order, counting each one started against the limits. */
export function nextWorkers(ctx: AdmitContext): QueuedWorker[] {
  const queue = ctx.queue ?? queuedWorkers();
  const loads = new Map<string, ProjectLoad>();
  // A claim already holds a slot, including one later in the queue than the job being considered.
  const fanout = new Map<string, number>();
  for (const job of queue) {
    if (!job.ownerSession || !isClaimed(job)) continue;
    fanout.set(job.ownerSession, (fanout.get(job.ownerSession) ?? ownerOpen(job.ownerSession, ctx.rows)) + 1);
  }
  const start: QueuedWorker[] = [];
  for (const job of queue) {
    const load = loads.get(job.project) ?? projectLoad(job.project, ctx.rows, ctx.heavy);
    loads.set(job.project, load);
    const limits = (ctx.limits ?? workerLimits)(job.project);
    // Another window is starting it: it takes its place, but isn't this window's to start.
    const claimed = isClaimed(job);
    // WP-171: not until everything it needs is delivered; it keeps its place and takes no seat meanwhile.
    if (!claimed && dependencyWait({ id: job.id, fanout: queuedFanout(job) }, ctx)) continue;
    if (!claimed && sharedWith(job, ctx.rows, start)) continue;
    const open = job.ownerSession ? (fanout.get(job.ownerSession) ?? ownerOpen(job.ownerSession, ctx.rows)) : undefined;
    // Past the cap a fan-out task waits, and it does not take a project seat. An ordinary worker is not capped here.
    if (!claimed && queuedFanout(job) !== undefined && open !== undefined && open >= FANOUT_MAX_TASKS) continue;
    if (!claimed && !decide(job, load, limits, ctx.room(job.harness)).start) continue;
    if (!claimed) {
      start.push(job);
      if (job.ownerSession) fanout.set(job.ownerSession, (open ?? ownerOpen(job.ownerSession, ctx.rows)) + 1);
    }
    loads.set(job.project, { running: load.running + 1, heavy: load.heavy + (job.heavy ? 1 : 0) });
  }
  return start;
}

/** Why a waiting worker waits right now (for its card and task_status). */
export function queuedLine(job: QueuedWorker, ctx: AdmitContext): string {
  const limits = (ctx.limits ?? workerLimits)(job.project);
  const load = projectLoad(job.project, ctx.rows, ctx.heavy);
  const room = ctx.room(job.harness);
  const needed = dependencyWait({ id: job.id, fanout: queuedFanout(job) }, ctx);
  if (needed) return needed.line;
  const shared = sharedWith(job, ctx.rows);
  if (shared) return filesWaitLine(shared);
  if (queuedFanout(job) !== undefined) {
    const pressure = fanoutPressure(job, ctx);
    if (pressure !== undefined && pressure >= FANOUT_MAX_TASKS) return fanoutWaitLine(pressure);
  }
  const why = decide(job, load, limits, room);
  return why.start ? why.line ?? "Starting now." : why.line;
}

// ---- a running worker the provider refused -----------------------------------------------------------------------

/**
 * A worker's turn ended refused for a usage or rate limit. The row stays open. App.tsx holds the report and the
 * crew only notes the pause; H8/E5 resumes the chat.
 */
export function holdForLimit(result: { status: string; errorClass?: string; retryable?: boolean }): boolean {
  return result.status === "failed" && result.errorClass === "usage_limit" && result.retryable !== false;
}

/**
 * A held worker whose refusal named no reset time: when it tries again by itself, in E5's order (accountWaterfall.ts
 * limitResetAt): the spent window's reset in the latest usage reading, else five hours after the refusal. A fresh
 * reading that shows room again brings it forward (`retryNow`).
 */
export function heldRetryAt(input: { refusedAt: number; resetsAt?: number; reading?: ProviderRateLimits }): number {
  return limitResetAt({ now: input.refusedAt, resetsAt: input.resetsAt, reading: input.reading });
}
export function retryNow(reading: ProviderRateLimits | undefined, refusedAt: number, now: number): boolean {
  return freshRoomAfter(reading, refusedAt, now);
}

export type HeldSeen = { resetsAt: number | undefined; refusedAt: number };

/**
 * What the app does with a held worker's limit notice (App.tsx), once per refusal: arm its resume at the refusal's
 * reset, else at E5's (heldRetryAt). `arm` is the reset to set (with resume on); `seen` is what to remember. A resume
 * Ash turned off after that stays off.
 */
export function planHeld(input: {
  limit: { resetsAt?: number; resumeAtReset?: boolean };
  seen?: HeldSeen;
  now: number;
  reading?: ProviderRateLimits;
}): { seen: HeldSeen; arm?: number } {
  const { limit, seen, now } = input;
  if (limit.resumeAtReset && limit.resetsAt != null)
    return { seen: seen ?? { resetsAt: limit.resetsAt, refusedAt: now } };
  if (seen && seen.resetsAt === limit.resetsAt) return { seen };
  const refusedAt = seen?.refusedAt ?? now;
  const arm = limit.resetsAt ?? heldRetryAt({ refusedAt, reading: input.reading });
  return { seen: { resetsAt: arm, refusedAt }, arm };
}

/** Its card's line: "Out of Claude usage. Tries again by itself at 3:40 PM, sooner if Claude shows room." */
export function heldLine(provider: string, at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  const when = new Date(at).toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
  return `Out of ${provider} usage. Tries again by itself at ${when}, sooner if ${provider} shows room.`;
}

/** For tests: a fresh, empty store in memory. */
export function resetWorkerPool(): void {
  for (const key of [LIMITS_KEY, HEAVY_KEY, QUEUE_KEY])
    try {
      localStorage.removeItem(key);
    } catch {
      /* none */
    }
  unsubscribe?.();
  unsubscribe = undefined;
  backend = memoryWorkerQueue();
  noteQueueEdit();
  copy = [];
  settingsEpoch = Promise.resolve();
  wroteSettings();
  settingsCopy = { limits: {}, heavy: new Set(), builderScale: { ...DEFAULT_BUILDER_SCALE, load: { kind: "default" } } };
  healthEpoch += 1;
  healthInflight = undefined;
  healthReader = defaultHealthReader;
  healthTimeoutMs = 3_000;
  healthNow = undefined;
  loading = undefined;
  resetSpendGate();
  heldTold.clear();
  heldEpisode.clear();
  queueDependency = undefined;
  changed();
}

// ---- the app's side ----------------------------------------------------------------------------------------------

/** Waiting workers the app is starting right now: their own delegate_task, asked again, always starts. */
const startingNow = new Set<string>();

/** Tasks whose owner has already been told about the hold they are in now. Cleared when the hold ends or the task leaves. */
const heldTold = new Set<string>();
/** How many separate holds this task has been told about. The next one gets a new note id, so a repeat is not swallowed. */
const heldEpisode = new Map<string, number>();

/**
 * What agentAppTasks.ts's delegate reads (App.tsx builds it): the rows of every chat, E5's room per provider, and the
 * card a waiting worker shows in the chat that asked for it.
 */
export function workerPoolHost(deps: {
  openRows(): Delegation[];
  room(harness: string): ProviderRoom;
  /** WP-171: what a task of a fan-out still waits for (AdmitContext.dependency). Absent: it can't wait for a provider. */
  dependency?: AdmitContext["dependency"];
  /** Put the waiting worker's card in its chat (it shows "Waiting for a free worker" until it starts). */
  card?(
    job: QueuedWorker,
    launch: { cwd: string; harness: string; model?: string; ranFrom?: string; ranEffort?: string; cliFallback?: string },
  ): void;
}): WorkerPoolHost {
  useLiveSpendSink();
  const ctx = (): AdmitContext => ({ rows: deps.openRows(), room: deps.room, dependency: deps.dependency });
  return {
    openRows: deps.openRows,
    waitsOnProviders: deps.dependency !== undefined,
    admit: (job) => (startingNow.has(job.id) ? { start: true } : admitWorker(job, ctx())),
    // WP-161: the machine is read before a launch is decided. The pump only reads it once something waits, so without
    // this the first launch would never meet a pause. A read that fails or is slow leaves the last fresh sample, or
    // none, which allows. Never throws.
    refreshHealth: () => refreshBuilderHealth(),
    enqueue: (job, launch) => {
      enqueueWorker(job);
      deps.card?.(job, launch);
    },
    started: ({ id, heavy, files }) => {
      if (heavy) markHeavy(id);
      if (files?.length) declareFiles(id, files);
      void dequeueWorker(id);
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
      void dequeueWorker(id);
      return true;
    },
    limits: workerLimits,
    setLimits: setWorkerLimits,
    model: projectWorkerModel,
    projectDefault: projectWorkerDefault,
    systemDefault: systemWorkerDefault,
  };
}

/**
 * WP-171: tell the owner the first time a task is held, and again only after that hold has ended. A task this pump did
 * not look at (its chat is not open here) keeps its mark, so the next look does not tell a second time. A task that
 * left the queue drops its mark. The episode count stays, so a later hold of the same task gets a new note id.
 */
function noteHeldTasks(
  queue: readonly QueuedWorker[],
  ctx: AdmitContext,
  held: ((job: QueuedWorker, note: { id: string; line: string }) => void) | undefined,
): void {
  const looked = new Set(queue.map((job) => job.id));
  const still = new Set<string>();
  for (const job of queue) {
    if (isClaimed(job)) continue;
    const wait = dependencyWait({ id: job.id, fanout: queuedFanout(job) }, ctx);
    if (wait?.reason !== "held") continue;
    still.add(job.id);
    if (!held || heldTold.has(job.id)) continue;
    const episode = (heldEpisode.get(job.id) ?? 0) + 1;
    heldEpisode.set(job.id, episode);
    heldTold.add(job.id);
    held(job, { id: `held-${job.id}-${episode}`, line: heldTaskLine(job, wait.line) });
  }
  for (const id of [...heldTold]) {
    if (!queuedWorkers().some((job) => job.id === id)) {
      heldTold.delete(id);
      continue;
    }
    if (!looked.has(id) || still.has(id)) continue;
    heldTold.delete(id);
  }
}

/**
 * Start what can start now (App.tsx calls it whenever a row or a chat changes, and on a timer for provider resets):
 * each through `start`, which asks its own delegate_task again. One that fails to start leaves the queue with the
 * reason, for its chat to hear (`failed`).
 */
export async function pumpWorkers(deps: {
  openRows(): Delegation[];
  room(harness: string): ProviderRoom;
  /** WP-171: what a task of a fan-out still waits for (AdmitContext.dependency). */
  dependency?: AdmitContext["dependency"];
  /**
   * WP-171: bring what `dependency` reads up to date before anyone is started: the rows of the providers the waiting
   * tasks need, and the check of what each finished provider made. A failure is ignored: what could not be read stays
   * unknown, and a task whose provider is unknown does not start.
   */
  settle?(queue: readonly QueuedWorker[]): Promise<void>;
  /** The owner chat can't take it any more (removed): the job is dropped. */
  ownerGone?(job: QueuedWorker): boolean;
  /** Its chat isn't loaded in this window right now: it keeps its place and starts once it is. */
  canStart?(job: QueuedWorker): boolean;
  start(job: QueuedWorker): Promise<unknown>;
  failed?(job: QueuedWorker, error: unknown): void;
  /** A waiting task was dropped (not a cap refusal, and not a chat that is gone). One line, naming the task. */
  dropped?(job: QueuedWorker, line: string): void;
  /** A task became held. Once per hold, naming the task. `id` changes when the same task is held again later. */
  held?(job: QueuedWorker, note: { id: string; line: string }): void;
}): Promise<QueuedWorker[]> {
  // WP-161: a fresh sample when the last one is old. A timeout keeps the last fresh sample, or none.
  await refreshBuilderHealth();
  for (const job of queuedWorkers()) if (deps.ownerGone?.(job)) await dequeueWorker(job.id);
  const queue = queuedWorkers().filter((job) => deps.canStart?.(job) ?? true);
  if (queue.length) await deps.settle?.(queue).catch(() => undefined);
  // WP-171: a hold is a queue wait, but the owner only hears it by being told. Once per hold, not on every look.
  noteHeldTasks(queue, { rows: deps.openRows(), room: deps.room, queue, dependency: deps.dependency }, deps.held);
  if (!queue.length) return [];
  const ready = nextWorkers({ rows: deps.openRows(), room: deps.room, queue, dependency: deps.dependency }).filter(
    (job) => !startingNow.has(job.id),
  );
  const started: QueuedWorker[] = [];
  for (const job of ready) {
    startingNow.add(job.id);
    try {
      // Claimed first, for a lease: of two windows only one starts it, and if this one dies before it has, the job is
      // free again when the lease runs out (or on the next launch), in its place. Starting is idempotent
      // (agentAppTasks.ts delegate: a task already recorded for the request is never started again).
      if (!(await claimWorker(job.id))) continue;
      try {
        await deps.start(job);
        started.push(job);
      } catch (error) {
        // The cap moved between the decision and the start. It keeps its place and is tried again; nobody is told
        // it failed, because it has not.
        if (capRefusal(error)) {
          await releaseForRetry(job);
          continue;
        }
        deps.failed?.(job, error);
        deps.dropped?.(job, droppedTaskLine(job, error));
      }
      // Started, or refused for good: either way it no longer waits.
      await finishWorker(job.id);
    } finally {
      startingNow.delete(job.id);
    }
  }
  return started;
}

/** How often waiting builders are checked against the machine again: a pause that clears lets them start. */
export const HEALTH_RECHECK_MS = 10_000;

/**
 * When to look at the machine again for waiting builders, with nothing else changing: soon, while any wait. Under
 * {@link HEALTH_STALE_MS}, so the sample the Needs you line reads never goes stale between looks.
 */
export function nextHealthCheck(now: number): number | undefined {
  return queuedWorkers().length ? now + HEALTH_RECHECK_MS : undefined;
}

/** When a waiting worker might start without any row changing: the soonest provider reset among the waiting. */
export function nextWake(room: (harness: string) => ProviderRoom, now: number): number | undefined {
  const times = queuedWorkers().flatMap((job) => {
    // A claim that runs out frees its job.
    if (job.claimedUntil && job.claimedUntil > now) return [job.claimedUntil];
    const r = room(job.harness);
    return !r.room && r.until && r.until > now ? [r.until] : [];
  });
  return times.length ? Math.min(...times) : undefined;
}
