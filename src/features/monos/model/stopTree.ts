// One Stop for a whole delegation tree (docs/PHASE-2-DESIGN.md H4; T3's ThreadManagementService.stopDelegatedTasks,
// MIT, re-told on MonoCode's rows).
//
// A Stop on a Lead or a leadership Mono (Ash's Stop button, `sessions.stop {"cascade":true}`) or on one task
// (`task_cancel`, the Stop on a row in the Lead's chat) stops everything beneath it:
// - the stopped chat's own turn first, then each row it owns, depth first: the row is cancelled (so it keeps this
//   reason, not the one a plain Stop gives), its worker's turn is stopped, and its report and any question wake are
//   thrown away so nothing restarts the work; then the rows that worker owns for that job, the same way;
// - it touches only rows owned by a chat it stopped, following `parent_id` (a Lead's rows for other work stay as they
//   are), and never a row whose report already reached its owner;
// - a worker that doesn't stop within 15 s, or whose Stop throws, or a row that can't be cancelled, is reported in
//   `stopFailed`; when the rows can't be loaded the chat still stops, and `unloaded` says its workers may still run.
import { isOpenDelegation, isOwed, type Delegation } from "./delegations";

export type StopTreeHost = {
  /** Every row still running or owed (delegations_list_open). */
  listOpen(): Promise<Delegation[]>;
  /** Every row of the tree a row belongs to (delegations_tree). */
  tree(id: string): Promise<Delegation[]>;
  /** Cancel what is still owed on these rows of one owner (DelegationTracker.cancelOwned). */
  cancel(
    owner: string,
    rows: Delegation[],
    reason: string,
    by: string,
  ): Promise<Delegation[]>;
  /** Whether a chat's turn is running in this window. */
  busy(sessionId: string): boolean;
  /** Stop one chat's turn: the app's own per-session Stop, never this cascade. */
  stop(sessionId: string): Promise<void>;
  /** The owner doesn't need this child's report or question any more: out of its batch and its queue. */
  dropReport(owner: string, childSession: string): void;
  /** How long one Stop may take before it counts as failed (tests shorten it). */
  stopTimeoutMs?: number;
  /** Take a followed brief (followedBriefs.ts) back out of its chat's queue if it still waits there. */
  unqueue?(childSession: string, requestId: string): void;
};

export type StopTreeOptions = {
  reason: string;
  /** Who stopped it, for the rows' logs: `user` (Ash), `owner:<session>` (task_cancel). */
  by: string;
};

export type StopTreeResult = {
  /** Chats whose turn was stopped, in the order they were stopped. */
  stopped: string[];
  /** Rows cancelled (their reports dropped), in order. */
  cancelled: string[];
  /** Chats whose Stop failed or timed out, or whose row couldn't be cancelled. */
  stopFailed: string[];
  /** Chats whose workers couldn't be loaded, so they may still be running (only set when there are any). */
  unloaded?: string[];
};

const STOP_TIMEOUT_MS = 15_000;

class Walk {
  readonly result: StopTreeResult = {
    stopped: [],
    cancelled: [],
    stopFailed: [],
  };
  private stoppedChats = new Set<string>();
  private seenRows = new Set<string>();
  private rows = new Map<string, Delegation>();

  constructor(
    private host: StopTreeHost,
    private options: StopTreeOptions,
  ) {}

  /** The rows to walk (loaded while the first chat stops); when some couldn't be, what is beneath `under` may run on. */
  use(loaded: LoadedRows, under: string): this {
    this.rows = loaded.rows;
    if (!loaded.complete) this.result.unloaded = [under];
    return this;
  }

  private failed(id: string): void {
    if (!this.result.stopFailed.includes(id)) this.result.stopFailed.push(id);
  }

  private sorted(filter: (row: Delegation) => boolean): Delegation[] {
    return [...this.rows.values()]
      .filter(filter)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Stop one chat's turn, once; a chat at rest is left as it is. */
  async stopChat(id: string): Promise<void> {
    if (this.stoppedChats.has(id)) return;
    this.stoppedChats.add(id);
    if (!this.host.busy(id)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.host.stop(id),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out")),
            this.host.stopTimeoutMs ?? STOP_TIMEOUT_MS,
          );
        }),
      ]);
      this.result.stopped.push(id);
    } catch {
      this.failed(id);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A row owned by a chat this Stop reached: cancel it, stop its worker, then what that worker owns for it. */
  async row(row: Delegation): Promise<void> {
    if (this.seenRows.has(row.id)) return;
    this.seenRows.add(row.id);
    const open = isOpenDelegation(row);
    const owed = isOwed(row);
    if (owed) {
      const changed = await this.host
        .cancel(row.ownerSession, [row], this.options.reason, this.options.by)
        .catch(() => undefined);
      // Still owed: its report could come back and restart the work, so this task didn't stop.
      if (!changed) this.failed(row.childSession);
      else if (changed.some((entry) => entry.id === row.id))
        this.result.cancelled.push(row.id);
    }
    // A followed brief went to a chat with work of its own (a Lead's long-running chat, a busy session): it leaves
    // that chat's queue if it still waits there, and the chat is never stopped for it; the walk goes on beneath it.
    if (row.follow) this.host.unqueue?.(row.childSession, row.requestId);
    else if (open) await this.stopChat(row.childSession);
    // After the Stop too: a settle that raced it may have queued the report.
    if (owed) this.host.dropReport(row.ownerSession, row.childSession);
    for (const child of this.sorted((entry) => entry.parentId === row.id))
      await this.row(child);
  }

  /** Every row a stopped chat owns. */
  async owned(id: string): Promise<void> {
    for (const row of this.sorted((entry) => entry.ownerSession === id))
      await this.row(row);
  }
}

type LoadedRows = { rows: Map<string, Delegation>; complete: boolean };

/**
 * The rows a Stop may need: every open or owed row, with the whole trees they sit in (finished rows link them). Never
 * throws: what it couldn't read leaves `complete` false (a missing tree may be the finished row linking the workers).
 */
async function loadRows(
  host: StopTreeHost,
  extra: Delegation[] = [],
): Promise<LoadedRows> {
  const rows = new Map<string, Delegation>(extra.map((row) => [row.id, row]));
  let open: Delegation[];
  try {
    open = await host.listOpen();
  } catch {
    return { rows, complete: false };
  }
  let complete = true;
  const trees = new Map<string, string>();
  for (const row of [...extra, ...open])
    if (!trees.has(row.rootId)) trees.set(row.rootId, row.id);
  for (const id of trees.values()) {
    try {
      for (const row of await host.tree(id)) rows.set(row.id, row);
    } catch {
      complete = false;
    }
  }
  // The open list is the freshest copy of what it holds.
  for (const row of [...extra, ...open]) rows.set(row.id, row);
  return { rows, complete };
}

/** Stop a chat and everything beneath it (Ash's Stop on a Mono, `sessions.stop {"cascade":true}`). */
export async function stopTree(
  chat: string,
  host: StopTreeHost,
  options: StopTreeOptions,
): Promise<StopTreeResult> {
  // The chat's own Stop doesn't wait for the rows to load; its workers stop only after it has.
  const rows = loadRows(host);
  const walk = new Walk(host, options);
  await walk.stopChat(chat);
  await walk.use(await rows, chat).owned(chat);
  return walk.result;
}

/** Stop one task and everything beneath it (task_cancel, the Stop on a row in the Lead's chat). */
export async function stopTask(
  row: Delegation,
  host: StopTreeHost,
  options: StopTreeOptions,
): Promise<StopTreeResult> {
  const loaded = await loadRows(host, [row]);
  const walk = new Walk(host, options).use(loaded, row.childSession);
  await walk.row(loaded.rows.get(row.id) ?? row);
  return walk.result;
}

/** Whether a Stop on this chat would reach anything beneath it (rows it owns that are still open or owed). */
export function hasWorkBeneath(
  chat: string,
  rows: readonly Delegation[],
): boolean {
  return rows.some((row) => row.ownerSession === chat && isOwed(row));
}
