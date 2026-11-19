// Hivra WP-171: what the app lends the worker queue so a task of a fan-out can wait for what it needs (App.tsx builds it).
//
// The queue decides synchronously, from the rows this window has. This module keeps those reads honest: a provider
// whose row this window lacks (a restart, an old one) is read from the store before the queue decides, and what a
// finished provider made is looked for on disk (fanoutChecks.ts) through the webview's own file commands.
import { readTextFile, statFiles } from "../../../platform/tauri/fs";
import type { Delegation } from "../../monos/model/delegations";
import { queuedWorker, type QueuedWorker } from "../../monos/model/workerPool";
import { fanoutDependency, settleFanout, verificationOf, type FileIo } from "../model/fanoutChecks";
import type { FanoutCheckpoint } from "../model/fanoutCheckpoint";
import { taskRequestId, type DependencyLookup, type RowView } from "../model/fanoutWaves";

/**
 * WP-172: the worker chat a plan's task has now, read from the plan's record: its latest start's request id, or its own
 * when it was never started again. Undefined when the plan is not there (it was finished or removed).
 */
export async function currentTaskSession(
  checkpoints: { list(owner: string): Promise<FanoutCheckpoint[]> } | undefined,
  owner: string,
  plan: string,
  name: string,
): Promise<string | undefined> {
  if (!checkpoints) return undefined;
  const found = (await checkpoints.list(owner)).find((entry) => entry.id === plan);
  if (!found) return undefined;
  const task = found.tasks.find((entry) => entry.name === name);
  return `app-${owner}-${task?.requestId ?? taskRequestId(plan, name)}`;
}

/** The files a check reads, through the app's own commands: a path that is not a text file reads as missing. */
export const tauriFileIo: FileIo = {
  exists: async (path) => {
    const [found] = await statFiles([path]);
    return found?.mtimeMs != null;
  },
  read: async (path) => readTextFile(path).catch(() => null),
};

/** A row from the store is asked for again no sooner than this, however often the queue is looked at. */
export const REFETCH_MS = 2_000;

export type FanoutHost = {
  /** The queue's `dependency` check (workerPool AdmitContext). */
  dependency: ReturnType<typeof fanoutDependency>;
  /** Run before the queue decides who starts (workerPool pumpWorkers `settle`). */
  settle(queue: readonly QueuedWorker[]): Promise<void>;
};

export function fanoutHost(deps: {
  /** Every row this window has: the open ones and the recent ones, any version. */
  rows(): readonly Delegation[];
  /** One row from the store, by the id of its worker chat, for the chat that owns it. */
  fetch(owner: string, session: string): Promise<Delegation | undefined>;
  /** The project folder a worker chat works for (where its finished work landed). */
  folder(session: string): string | undefined;
  /**
   * WP-144: the worker chat is held for its fresh-eyes review (fresh-eyes/model/gate.ts heldForReview). It has not
   * started yet, so a task that needs it waits instead of being held as lost.
   */
  reviewing?(session: string): boolean;
  /** WP-172: the plan records a provider's current chat is read from (a start again takes a new one). */
  checkpoints?(): { list(owner: string): Promise<FanoutCheckpoint[]> } | undefined;
  io?: FileIo;
  now?(): number;
}): FanoutHost {
  const now = deps.now ?? Date.now;
  /** Rows read from the store, for the queue to see; the window's own rows win once it has them. */
  const fetched = new Map<string, RowView>();
  const askedAt = new Map<string, number>();
  /** WP-172: a waiting task names its provider by the chat the plan first gave it; this is the chat it has now. */
  const latest = new Map<string, string>();
  const chatOf = (session: string) => latest.get(session) ?? session;

  const live = (session: string): RowView | undefined => {
    let newest: Delegation | undefined;
    for (const row of deps.rows()) if (row.childSession === session && (!newest || row.version >= newest.version)) newest = row;
    return newest;
  };
  const lookup: DependencyLookup = {
    row: (session) => live(chatOf(session)) ?? fetched.get(chatOf(session)),
    queued: (session) => queuedWorker(chatOf(session)) !== undefined || deps.reviewing?.(chatOf(session)) === true,
    verified: (session, row) => verificationOf(chatOf(session), row),
  };
  return {
    dependency: fanoutDependency(lookup, now),
    settle: async (queue) => {
      const checkpoints = deps.checkpoints?.();
      const resolved = await settleFanout(queue, {
        // The window's rows only: a row read from the store is read again, so a running one never sticks.
        row: live,
        fetchRow: async (session, owner) => {
          const at = now();
          const last = askedAt.get(session);
          if (last !== undefined && at - last < REFETCH_MS) return fetched.get(session);
          askedAt.set(session, at);
          return deps.fetch(owner, session);
        },
        keep: (session, row) => void fetched.set(session, row),
        folder: deps.folder,
        io: deps.io ?? tauriFileIo,
        now,
        current: (owner, plan, name) => currentTaskSession(checkpoints, owner, plan, name),
      });
      for (const [planned, session] of resolved) latest.set(planned, session);
    },
  };
}
