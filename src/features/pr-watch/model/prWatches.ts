// PR and CI watch that wakes the owning Lead (docs/HUB-PLAN.md phase 4; src-tauri/src/pr_watch).
//
// The poller, the reads and the wake rules live in Rust, so a hidden window never pauses them. This side:
// - delivers each stored wake to its owner's chat through the Mono's queue (an app notification: it waits for the
//   Mono to be idle and never steers its work), marking it queued before it enters the queue and delivered when it goes
//   out as a turn. Boot recovery (the main window) re-queues one that never arrived, exactly once;
// - keeps the watches for the board: a Mono that is idle but waiting on a pull request reads "Waiting on CI", and
//   Being built shows the pull request as a job under that Mono.
import { invoke } from "@tauri-apps/api/core";
import type { QueuedMessage, Session } from "../../sessions/model/session";

/** The pull request as of the last read (pr_watch::Status). */
export type PrWatchStatus = {
  pr: "open" | "merged" | "closed" | "";
  draft: boolean;
  /** The gate is the required checks (true) or every check (false, none is required). */
  required: boolean;
  checks: number;
  pending: number;
  failed: string[];
  passed: boolean;
  mergeable: "mergeable" | "conflicting" | "unknown" | "";
  reviewDecision: string | null;
  /** Commits main has that the branch lacks (WP-202; 0 when unknown). */
  behind?: number;
  /** GitHub's merge state: BEHIND, DIRTY, CLEAN and the rest (WP-202; empty when unknown). */
  mergeState?: string;
};

/** One watch, as pr_watch.rs serializes it. */
export type PrWatch = {
  id: string;
  ownerSession: string;
  ownerMono: string | null;
  ownerName: string | null;
  repo: string;
  number: number;
  url: string;
  title: string;
  /** The hub project id (or folder) it belongs to. */
  project: string | null;
  worktree: string | null;
  repoRoot: string | null;
  askIds: string[];
  state: "watching" | "ended";
  endReason:
    | "merged"
    | "closed"
    | "unwatched"
    | "stopped"
    | "owner-gone"
    | "unreadable"
    | "comment-limit"
    | null;
  status: PrWatchStatus;
  headSha: string | null;
  headRef: string;
  baseRef: string;
  mergeSha: string | null;
  readFailures: number;
  lastError: string | null;
  lastReadAt: number | null;
  nextReadAt: number;
  wakesTotal: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
};

export type PrWakeDelivery = "pending" | "queued" | "delivered" | "disposed";

/** One stored wake: its id is the queued message's id and its receipt in the owner's transcript. */
export type PrWake = {
  id: string;
  watchId: string;
  ownerSession: string;
  seq: number;
  kind: "update" | "merged" | "closed" | "unreadable";
  title: string;
  outcome: "failed" | "completed" | "updated";
  text: string;
  delivery: PrWakeDelivery;
  createdAt: number;
  updatedAt: number;
};

export type PrWatchAddInput = {
  ownerSession: string;
  ownerMono?: string;
  ownerName?: string;
  repo: string;
  number: number;
  worktree?: string;
  /** The owner's projects: one with a checkout of the repository is where `mc/pr-<n>` is made. */
  projects: { folder: string; hubId?: string }[];
  askIds?: string[];
};

export type PrWatchAdded = { watch: PrWatch; wasWatching: boolean; checkout: string };

export type PrWatchRemoveInput = {
  ownerSession: string;
  id?: string;
  repo?: string;
  number?: number;
  reason?: "unwatched" | "stopped" | "owner-gone";
};

/** pr_watch.rs's commands; tests pass an in-memory one. */
export type PrWatchBackend = {
  add(input: PrWatchAddInput): Promise<PrWatchAdded>;
  remove(input: PrWatchRemoveInput): Promise<PrWatch[]>;
  list(ownerSession?: string): Promise<PrWatch[]>;
  wakesOpen(): Promise<PrWake[]>;
  setDelivery(ids: string[], delivery: PrWakeDelivery): Promise<PrWake[]>;
  /** Which of these message ids already reached the owner's transcript (delegations.rs, shared). */
  seen(ownerSession: string, messageIds: string[]): Promise<string[]>;
};

export const tauriPrWatches: PrWatchBackend = {
  add: (input) => invoke("pr_watch_add", { input }),
  remove: (input) => invoke("pr_watch_remove", { input }),
  list: (ownerSession) => invoke("pr_watch_list", { ownerSession: ownerSession ?? null }),
  wakesOpen: () => invoke("pr_watch_wakes_open"),
  setDelivery: (ids, delivery) => invoke("pr_watch_wake_delivery", { ids, delivery }),
  seen: (ownerSession, messageIds) =>
    invoke("delegations_reports_seen", { ownerSession, messageIds }),
};

/** pr_watch.rs's events. */
export const PR_WATCHES_CHANGED = "monocode:pr-watches-changed";
export const PR_WATCH_WAKE = "monocode:pr-watch-wake";

/** A wake's queued message id (and receipt) starts with this. */
export const PR_WAKE_PREFIX = "pr-watch-";

export function isPrWakeMessage(id: string): boolean {
  return id.startsWith(PR_WAKE_PREFIX);
}

/**
 * The turn a wake becomes: an app notification (`monoSessionCompletion`), so it waits for an idle Mono, is hidden as
 * the user's bubble, carries its receipt (`appRequestId`) and is never steered into a running turn.
 */
export function wakeMessage(wake: PrWake): QueuedMessage {
  return {
    id: wake.id,
    text: wake.text,
    attachments: [],
    monoSessionCompletion: {
      sessionId: wake.watchId,
      title: wake.title,
      status: wake.outcome === "failed" ? "failed" : "completed",
    },
  };
}

/** The words pr_watch/wake.rs puts in a wake's title when required or listed checks failed (its SUMMARY_FAILED). */
export const CHECKS_FAILED_SUMMARY = "checks failed";

/**
 * WP-164: a wake that says checks failed is a red CI, one of the notable programme events (notableEvents.ts). A merge
 * conflict is a failed wake too, but it is not a red CI, and neither is an unreadable pull request.
 */
export function ciRedEvent(wake: PrWake): { id: string; kind: "ci-red"; text: string; at: number } | null {
  if (wake.kind !== "update" || wake.outcome !== "failed") return null;
  if (!wake.title.includes(CHECKS_FAILED_SUMMARY)) return null;
  return { id: wake.id, kind: "ci-red", text: wake.title, at: wake.createdAt };
}

/** What the watch says about the pull request now, in a few calm words. */
export function prWatchLine(watch: Pick<PrWatch, "status" | "state" | "endReason">): string {
  if (watch.state === "ended") {
    switch (watch.endReason) {
      case "merged":
        return "Merged";
      case "closed":
        return "Closed";
      case "unreadable":
        return "Stopped watching: GitHub could not be read";
      case "comment-limit":
        return "Stopped watching after many comments";
      default:
        return "Not watched any more";
    }
  }
  const s = watch.status;
  const which = s.required ? "required checks" : "checks";
  if (s.mergeable === "conflicting") return `Conflicts with its base branch`;
  if (s.failed.length)
    return `${s.failed.length} ${s.failed.length === 1 ? which.replace(/s$/, "") : which} failed`;
  if (!s.checks) return "Waiting for checks to start";
  if (s.pending) return `${s.checks - s.pending} of ${s.checks} ${which} done`;
  if (s.passed) {
    if (s.reviewDecision === "CHANGES_REQUESTED") return "Checks passed; changes requested";
    if (s.behind && s.behind > 0) return `Checks passed; ${s.behind} ${s.behind === 1 ? "commit" : "commits"} behind main`;
    if (s.reviewDecision === "REVIEW_REQUIRED") return "Checks passed; waiting for review";
    return "Checks passed; waiting to merge";
  }
  return "Watching";
}

/** What the tracker needs from the app. */
export type PrWatchHost = {
  /** Whether a chat is a Mono's own chat (the only kind that watches). */
  isMono(id: string): boolean;
  /** The owner's chat as this window has it, else as stored; null when it no longer exists. Throws when it can't tell. */
  load(id: string): Promise<Session | null>;
  /** Put a wake in the owner's queue (deduplicated by its id). */
  queueWake(ownerId: string, message: QueuedMessage): Promise<void>;
  /**
   * A wake is going to a live owner for the first time. Called once per wake, after it is marked queued, so a write
   * that failed (and will be tried again) has not been noticed yet, and never again when a crash puts it in the queue a
   * second time. `watch` is the watch as of the last read, when the list has one. A throw is logged and does not hold
   * the wake back.
   */
  noticed?(wake: PrWake, about: { owner: Session; watch: PrWatch | undefined }): void;
};

/**
 * The owner's chat as this window has it, else as stored (`read`: sessionStore's getSession). Null only when the store
 * says there is no such chat; a read that fails throws, so the owner is skipped this round instead of dropped.
 */
export async function loadOwner(
  open: readonly Session[],
  id: string,
  read: (id: string) => Promise<Session | null>,
): Promise<Session | null> {
  return open.find((session) => session.id === id) ?? (await read(id));
}

/** `waiting`: owners whose chat couldn't be read this round (their wakes are tried again shortly). */
export type DeliverSummary = { queued: number; delivered: number; dropped: number; waiting?: number };

/** How soon a round that skipped an unreadable owner is tried again. */
export const OWNER_RETRY_MS = 30_000;

/** The app's side of the watches: one per window. Only the main window delivers. */
export class PrWatchTracker {
  private tail: Promise<unknown> = Promise.resolve();
  private watches: PrWatch[] = [];
  private subscribers = new Set<() => void>();
  private version = 0;

  constructor(
    private backend: PrWatchBackend,
    private host: PrWatchHost,
  ) {}

  /** Store calls one at a time, in order, so a delivery never overtakes its queueing. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  // ---- the board ----

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  snapshot = (): number => this.version;

  /** Every watch the board knows: live ones, and those that ended in the last day. */
  all(): readonly PrWatch[] {
    return this.watches;
  }

  /** A chat's live watches. */
  watchingFor(ownerSession: string): PrWatch[] {
    return this.watches.filter(
      (watch) => watch.ownerSession === ownerSession && watch.state === "watching",
    );
  }

  /** Read the watches again (after a change event, or once at start). */
  async refresh(): Promise<void> {
    const watches = await this.backend.list();
    this.watches = watches;
    this.version++;
    for (const listener of this.subscribers) listener();
  }

  // ---- delivery ----

  /**
   * Put every wake still owed into its owner's queue: a pending one is marked queued first (so a crash between the
   * two re-queues it, never loses it); a queued one that already reached the transcript is marked delivered, one that
   * is neither there nor in the queue (the app died before the queue was saved) is queued again. A wake whose owner is
   * gone is dropped and its watches end; one whose owner can't be read right now waits for the next round.
   */
  deliver(): Promise<DeliverSummary> {
    return this.serial(async () => {
      const summary: DeliverSummary = { queued: 0, delivered: 0, dropped: 0 };
      const open = await this.backend.wakesOpen();
      const gone = new Set<string>();
      const unread = new Set<string>();
      for (const wake of open) {
        if (unread.has(wake.ownerSession)) continue;
        let owner: Session | null = null;
        if (!gone.has(wake.ownerSession) && this.host.isMono(wake.ownerSession)) {
          try {
            owner = await this.host.load(wake.ownerSession);
          } catch (error) {
            console.warn("PR watch: couldn't read the owner's chat; its wakes wait for the next round", error);
            unread.add(wake.ownerSession);
            continue;
          }
        }
        if (!owner) {
          gone.add(wake.ownerSession);
          await this.backend.setDelivery([wake.id], "disposed");
          summary.dropped++;
          continue;
        }
        if (wake.delivery === "queued") {
          const [seen] = await this.backend.seen(wake.ownerSession, [wake.id]);
          if (seen) {
            await this.backend.setDelivery([wake.id], "delivered");
            summary.delivered++;
            continue;
          }
          if (owner.queuedMessages?.some((message) => message.id === wake.id)) continue;
        } else {
          await this.backend.setDelivery([wake.id], "queued");
          this.notice(wake, owner);
        }
        await this.host.queueWake(wake.ownerSession, wakeMessage(wake));
        summary.queued++;
      }
      for (const ownerSession of gone)
        await this.backend
          .remove({ ownerSession, reason: "owner-gone" })
          .catch(() => [] as PrWatch[]);
      if (unread.size) summary.waiting = unread.size;
      return summary;
    });
  }

  private notice(wake: PrWake, owner: Session): void {
    try {
      this.host.noticed?.(wake, { owner, watch: this.watches.find((watch) => watch.id === wake.watchId) });
    } catch (error) {
      console.warn("PR watch: couldn't note a wake; it is still delivered", error);
    }
  }

  /** A wake went to its owner as a turn. */
  delivered(messageId: string): void {
    if (!isPrWakeMessage(messageId)) return;
    void this.serial(() => this.backend.setDelivery([messageId], "delivered")).catch(() => undefined);
  }

  /** Ash removed a wake from the owner's queue himself: it is not owed any more. */
  discarded(messageId: string): void {
    if (!isPrWakeMessage(messageId)) return;
    void this.serial(() => this.backend.setDelivery([messageId], "disposed")).catch(() => undefined);
  }

  /** Ash stops a watch from the board. */
  stop(watch: Pick<PrWatch, "id" | "ownerSession">): Promise<PrWatch[]> {
    return this.serial(() =>
      this.backend.remove({ ownerSession: watch.ownerSession, id: watch.id, reason: "stopped" }),
    );
  }
}

/** What the Monos rail says for an idle Mono with live watches (MonoRailSection shows an idle Mono's activity). */
export function waitingActivity(watches: readonly PrWatch[]): string | undefined {
  if (!watches.length) return undefined;
  if (watches.length > 1) return `Waiting on CI for ${watches.length} pull requests`;
  return `Waiting on CI: #${watches[0].number}`;
}
