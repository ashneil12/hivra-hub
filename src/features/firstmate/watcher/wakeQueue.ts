// Hivra WP-11: the app's side of the first mate's wake queue (src-tauri/src/watcher/queue.rs). The classifier decides
// (classifier.ts); this puts each wake in Rust's queue and delivers what an owner is owed as one turn.
//
// - **Add**: a wake goes into the queue once per owner and key (Rust dedupes, before and after a restart).
// - **Drain**: once the first mate is idle, every wake it is owed goes out as one hidden app turn (`fm-wake-<owner>-<through>`), through the
//   owner's own queue: it waits for the first mate to be idle and is never steered into running work, like a report.
//   While one drained turn waits, later wakes wait for the next (it acknowledges only what it carried).
// - **Acknowledge**: when that turn goes to the first mate, everything through its `through` is acknowledged; anything
//   newer is drained next.
// - **Restart**: a queued turn that already reached the transcript is acknowledged; one that is neither there nor in the
//   queue is drained again. An owner whose chat is gone is disposed.
import { invoke } from "@tauri-apps/api/core";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import type { Wake as Decided } from "./classifier";

export type WakeDelivery = "pending" | "queued" | "delivered" | "acknowledged" | "disposed";

/** One stored wake, as watcher/queue.rs serializes it. */
export type QueuedWake = {
  id: string;
  ownerSession: string;
  seq: number;
  kind: string;
  key: string;
  delegationId: string | null;
  generation: number | null;
  title: string | null;
  text: string;
  delivery: WakeDelivery;
  deliveryMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type Drained = { ownerSession: string; messageId: string; through: number; text: string; wakes: QueuedWake[] };

export type Timer = { id: string; ownerSession: string; dueAt: number; note: string; state: string; createdAt: number };

/** One armed check, as watcher/checks.rs serializes it. The command's output is never in here. */
export type Check = {
  id: string;
  ownerSession: string;
  note: string;
  intervalMs: number;
  nextAt: number;
  deadline: number;
  state: string;
  createdAt: number;
};

export type WakeQueueBackend = {
  add(input: { ownerSession: string; kind: string; key: string; delegationId?: string; generation?: number; title?: string; text: string }): Promise<{ wake: QueuedWake; fresh: boolean }>;
  open(): Promise<QueuedWake[]>;
  drain(ownerSession: string): Promise<Drained | null>;
  delivered(messageId: string): Promise<QueuedWake[]>;
  setDelivery(messageId: string, delivery: "disposed"): Promise<QueuedWake[]>;
  disposeOwner(ownerSession: string): Promise<number>;
  /** Which of these message ids already reached the owner's transcript (delegations.rs, shared). */
  seen(ownerSession: string, messageIds: string[]): Promise<string[]>;
  /** Fire due timers into the queue and prune old rows. */
  tick(): Promise<{ fired: QueuedWake[]; pruned: number }>;
  timerSet(input: { ownerSession: string; dueAt: number; note: string }): Promise<Timer>;
  timerCancel(ownerSession: string, id: string): Promise<Timer | null>;
  timers(ownerSession: string): Promise<Timer[]>;
  /** WP-104: poll a safe command, in the chat's own folder, until it exits 0 or its text matches, then one wake. */
  checkSet(input: { ownerSession: string; command: string; pattern: string; note: string; intervalMs: number; cwd: string }): Promise<Check>;
  checkCancel(ownerSession: string, id: string): Promise<Check | null>;
};

export const tauriWakeQueue: WakeQueueBackend = {
  add: (input) => invoke("watcher_wake_add", { input }),
  open: () => invoke("watcher_wakes_open"),
  drain: (ownerSession) => invoke("watcher_wake_drain", { ownerSession }),
  delivered: (messageId) => invoke("watcher_wake_delivered", { messageId }),
  setDelivery: (messageId, delivery) => invoke("watcher_wake_delivery", { messageId, delivery }),
  disposeOwner: (ownerSession) => invoke("watcher_dispose_owner", { ownerSession }),
  seen: (ownerSession, messageIds) => invoke("delegations_reports_seen", { ownerSession, messageIds }),
  tick: () => invoke("watcher_tick"),
  timerSet: (input) => invoke("watcher_timer_set", { input }),
  timerCancel: (ownerSession, id) => invoke("watcher_timer_cancel", { ownerSession, id }),
  timers: (ownerSession) => invoke("watcher_timers", { ownerSession }),
  checkSet: (input) => invoke("watcher_check_set", { input }),
  checkCancel: (ownerSession, id) => invoke("watcher_check_cancel", { ownerSession, id }),
};

/** watcher/mod.rs's event when a wake was stored. */
export const FIRSTMATE_WAKE = "monocode:firstmate-wake";
/** A drained turn's message id (and receipt) starts with this (watcher/queue.rs MESSAGE_PREFIX). */
export const WAKE_MESSAGE_PREFIX = "fm-wake-";

export function isWakeMessage(id: string): boolean {
  return id.startsWith(WAKE_MESSAGE_PREFIX);
}

const ownerMessagePrefix = (owner: string) => `${WAKE_MESSAGE_PREFIX}${owner}-`;

/**
 * The turn a drain becomes: an app notification (`monoSessionCompletion`), so it waits for an idle first mate, is
 * hidden as the person's bubble, carries its receipt and is never steered into a running turn (as PR watch wakes are).
 */
export function wakeTurn(drained: Drained): QueuedMessage {
  return {
    id: drained.messageId,
    text: drained.text,
    attachments: [],
    monoSessionCompletion: { sessionId: `watcher-${drained.ownerSession}`, title: "Watcher", status: "completed" },
  };
}

export type WakeQueueHost = {
  /** Whether a chat is a first mate (a Mono's own chat or a coding-team chat): only they are woken. */
  isFirstMate(id: string): boolean;
  /** The owner's chat as this window has it, else as stored; null when it no longer exists. Throws when it can't tell. */
  load(id: string): Promise<Session | null>;
  /** Put a turn in the owner's queue (deduplicated by its id). */
  queueWake(ownerId: string, message: QueuedMessage): Promise<void>;
};

export type DeliverSummary = { queued: number; acknowledged: number; dropped: number; waiting?: number };

/** The app's side of the queue: one per window. Only the main window delivers. */
export class WakeQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private backend: WakeQueueBackend,
    private host: WakeQueueHost,
  ) {}

  /** Store calls one at a time, in order, so a delivery never overtakes its queueing. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** A wake the classifier decided on, for a first mate's queue. Wakes for any other chat are not the queue's. */
  add(wake: Decided): Promise<boolean> {
    if (wake.route !== "queue" || !this.host.isFirstMate(wake.ownerSession)) return Promise.resolve(false);
    const kind = wake.kind === "worker-blocked" ? "blocked" : wake.kind === "stall" || wake.kind === "timer" ? wake.kind : "note";
    return this.serial(async () => {
      const added = await this.backend.add({
        ownerSession: wake.ownerSession,
        kind,
        key: wake.key,
        ...(wake.delegationId ? { delegationId: wake.delegationId } : {}),
        ...(wake.generation !== undefined ? { generation: wake.generation } : {}),
        ...(wake.title ? { title: wake.title } : {}),
        text: wake.text,
      });
      return added.fresh;
    });
  }

  /** Put what each owner is owed into its queue, as one turn (module notes). */
  deliver(): Promise<DeliverSummary> {
    return this.serial(async () => {
      const summary: DeliverSummary = { queued: 0, acknowledged: 0, dropped: 0 };
      const open = await this.backend.open();
      const owners = [...new Set(open.map((wake) => wake.ownerSession))];
      let unread = 0;
      for (const ownerId of owners) {
        let owner: Session | null = null;
        if (this.host.isFirstMate(ownerId)) {
          try {
            owner = await this.host.load(ownerId);
          } catch (error) {
            console.warn("Watcher: couldn't read the first mate's chat; its wakes wait for the next round", error);
            unread++;
            continue;
          }
        }
        if (!owner) {
          summary.dropped += await this.backend.disposeOwner(ownerId);
          continue;
        }
        // Drained only when the first mate can take it: a busy one is looked at again on the next round, so the turn
        // carries what is still true then (a notice about a worker that moved on meanwhile is dropped at the drain).
        if (owner.busy) continue;
        // A drained turn already waiting in its queue carries what it carries; the rest wait for it to go out.
        if (owner.queuedMessages?.some((message) => message.id.startsWith(ownerMessagePrefix(ownerId)))) continue;
        const messages = [...new Set(open.filter((w) => w.ownerSession === ownerId && w.delivery === "queued").map((w) => w.deliveryMessage!).filter(Boolean))];
        if (messages.length) {
          // After a restart: a turn that reached the transcript is acknowledged; one that didn't is drained again below.
          const seen = await this.backend.seen(ownerId, messages);
          for (const id of seen) summary.acknowledged += (await this.backend.delivered(id)).length;
        }
        const drained = await this.backend.drain(ownerId);
        if (!drained) continue;
        await this.host.queueWake(ownerId, wakeTurn(drained));
        summary.queued++;
      }
      if (unread) summary.waiting = unread;
      return summary;
    });
  }

  /** A drained turn went to its first mate: acknowledged through what it carried. Returns once stored. */
  delivered(messageId: string): Promise<void> {
    if (!isWakeMessage(messageId)) return Promise.resolve();
    // Anything that arrived while it waited goes out next.
    return this.serial(() => this.backend.delivered(messageId)).then(
      () => void this.deliver().catch(() => undefined),
      () => undefined,
    );
  }

  /** The person removed a drained turn from the queue: what it carried is not owed any more. */
  discarded(messageId: string): void {
    if (!isWakeMessage(messageId)) return;
    void this.serial(() => this.backend.setDelivery(messageId, "disposed")).catch(() => undefined);
  }

  /** The watcher's look: due timers fire into the queue. Resolves with how many fired. */
  tick(): Promise<number> {
    return this.serial(async () => (await this.backend.tick()).fired.length);
  }
}

let current: WakeQueue | null = null;

/** The window's queue, once useFirstMateWakes made it (the stall watcher hands its wakes here). */
export function currentWakeQueue(): WakeQueue | null {
  return current;
}

export function setCurrentWakeQueue(queue: WakeQueue | null): void {
  current = queue;
}
