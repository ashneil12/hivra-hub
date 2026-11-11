// Delegations that survive restarts (docs/PHASE-2-DESIGN.md, H2).
//
// Every monitored sessions.start / sessions.send from a Mono is a stored row (src-tauri/src/delegations.rs). The row is
// the truth and MonoSessionCompletionBatches is a cache of it for the running app, so the Mono still gets exactly one
// report per generation of the work after a restart, a crash, an install or a usage-limit resume:
// - live: record before the child starts, settle when its turn ends, mark queued (before the report enters the
//   Mono's queue) and delivered (when the report goes to the Mono as a turn);
// - boot: a finished row whose report never arrived is queued once; one still running waits for its resumed turn;
//   one whose child is gone is reported cancelled; one whose owner is gone is dropped;
// - a resumed turn (auto-continue, a usage-limit resume, a later message in a cut-off child) re-attaches to the
//   child's row and bumps its generation, so its report has its own receipt (`mono-completion-<request>-g<n>`).
import { workerTitle } from "./workerTitle";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  failedReason,
  isProviderErrorClass,
} from "../../../integrations/harness/core/providerFailure";
import type { ControlOutcome } from "../../orchestration/model/orchestration";
import {
  CONTINUE_PROMPT,
  wasTurnInterrupted,
} from "../../sessions/model/inFlight";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import {
  completionMessage,
  completionReceipt,
  monoSessionCompletionResult,
  withReviewBackstop,
  type MonoSessionCompletionResult,
} from "./monoSessionCompletion";
import { storedReview } from "./workerReview";
import type { CrewFailureNote } from "../../crew/model/advice";

export type DelegationState =
  | "running"
  | "question"
  | "completed"
  | "failed"
  | "cancelled";
export type DeliveryState =
  | "pending"
  | "queued"
  | "delivered"
  | "acknowledged"
  | "disposed";

/** One row, as delegations.rs serializes it. */
export type Delegation = {
  id: string;
  ownerSession: string;
  ownerMono: string | null;
  batchId: string | null;
  parentId: string | null;
  rootId: string;
  childSession: string;
  requestId: string;
  generation: number;
  project: string | null;
  title: string | null;
  brief: string | null;
  goal: string | null;
  askIds: string[];
  state: DelegationState;
  errorClass: string | null;
  error: string | null;
  retryable: boolean | null;
  resetsAt: number | null;
  result: string | null;
  pendingQuestion: string | null;
  delivery: DeliveryState;
  deliveryMessage: string | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
  log: Record<string, unknown>[];
  version: number;
  mirroredVersion: number;
  mirrorError: string | null;
  /** A followed brief (followedBriefs.ts): reported by watching the child chat. Absent on older rows. */
  follow?: FollowMode | null;
  /**
   * A running row's stall (delegations.rs, workerStall.ts): its worker went quiet, loops, stopped without reporting, or
   * said it cannot finish (`blocked`). Not a state: the row stays running, and any move of it clears the stall. Absent on
   * older rows.
   */
  stallKind?: StallKind | null;
  stallReason?: string | null;
  /** Since when it has been stuck this way (its last activity, or when the loop was seen), epoch ms. */
  stalledAt?: number | null;
  /** This worker's report owes a self-review (workerReview.ts); absent on older rows and followed briefs. */
  reviewRequired?: boolean;
  /** The accepted self-review, as JSON (workerReview.ts), once the row is settled. */
  selfReview?: string | null;
  /**
   * Hivra WP-10 (src-tauri/src/firstmate/): the one status shown anywhere, computed in Rust from the row and its gates.
   * Read it; never work a status out from `state` here. Absent only on rows from an older build.
   */
  status?: FirstMateStatus;
  /** A plain line beside the status (a stall, a question, why it failed), when there is one. */
  statusNotice?: string | null;
  /** Who an open question waits on: "person" once the first mate passed it on; none means its first mate. */
  questionOwner?: "person" | null;
  /** The completion gates' verdict (WP-40): "pending", "passed", "failed" or "unsure"; none when no gates apply. */
  gateVerdict?: string | null;
  /** The worker's typed final report, as JSON (firstmate/model/report.ts storedReport). */
  report?: string | null;
};

/** Hivra's five statuses (docs/hivra/SPEC.md section 4). */
export type FirstMateStatus = "working" | "needs-you" | "done" | "failed" | "paused";

/**
 * How a running worker is stuck: no output (`quiet`), the same step over and over (`loop`), idle without a report, or
 * `blocked` — the Lead or the worker itself declared it cannot finish (task_cannot), with a plain reason.
 */
export type StallKind = "quiet" | "loop" | "idle" | "blocked";

export type StallInput = {
  id: string;
  /** The turn that was judged: a stall never lands on a newer one. */
  generation: number;
  /** None clears the stall. */
  kind?: StallKind;
  reason?: string;
  since?: number;
  by?: string;
};

/**
 * How a followed brief went in: queued behind a busy chat's work, steered into it, or a leadership Mono's brief to a
 * project Lead's long-running chat (delegations.rs, followedBriefs.ts).
 */
export type FollowMode = "queue" | "steer" | "lead";

export type RecordInput = {
  ownerSession: string;
  ownerMono?: string;
  batchId?: string;
  /** WP-176 round 5: the owner's row this one redoes. Written with the row, in the same transaction. */
  redoes?: string;
  requestId: string;
  childSession: string;
  project?: string;
  title?: string;
  brief?: string;
  goal?: string;
  askIds?: string[];
  by?: string;
  follow?: FollowMode;
  /** The open row the owner works for (a Lead's current brief), when the app knows it. */
  parentId?: string;
  /** WP-70: the shared task this work moves. */
  taskId?: string;
  /** A delegated worker's report must carry a self-review; its settle is refused without one (workerReview.ts). */
  reviewRequired?: boolean;
  /** WP-141: why the crew picked this CLI. Stored as `why` on the row's "recorded" line. */
  pickReason?: string;
};

export type SettleInput = {
  id: string;
  generation: number;
  state: "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  errorClass?: string;
  retryable?: boolean;
  resetsAt?: number;
  by?: string;
  /** The accepted self-review, as JSON: what the worker checked, how, and what is still open. */
  selfReview?: string;
};

export type DeliveryInput = {
  ids?: string[];
  /** Every row a report message carries. */
  messageId?: string;
  delivery: DeliveryState;
  /** The report message a queued row now waits in. */
  queuedMessage?: string;
  by?: string;
};

export type ChatBindInput = {
  providerSession: string;
  chatId: string;
  monoId?: string;
  role?: "lead" | "mono" | "worker" | "checker";
  delegationId?: string;
};

/** A chat's own rows (the task tools, H3): by id or request, or (neither) the ones still running or owed. */
export type OwnedQuery = {
  ownerSession: string;
  ids?: string[];
  requestIds?: string[];
};

export type Change = { applied: boolean; row: Delegation | null };

/** The store's commands (delegations.rs); tests pass an in-memory one. */
export type DelegationsBackend = {
  record(input: RecordInput): Promise<Delegation>;
  settle(input: SettleInput): Promise<Change>;
  reattach(
    childSession: string,
    resume: boolean,
    by?: string,
  ): Promise<Delegation | null>;
  /** A worker's question on its row, or (null) its answer; `detail` goes on the row's log (request id, the answer). */
  setQuestion(
    id: string,
    question: string | null,
    by?: string,
    detail?: Record<string, unknown>,
  ): Promise<Change>;
  setDelivery(input: DeliveryInput): Promise<Delegation[]>;
  cancel(ids: string[], reason?: string, by?: string): Promise<Delegation[]>;
  refuse(id: string, by?: string): Promise<Change>;
  listOpen(): Promise<Delegation[]>;
  tree(id: string): Promise<Delegation[]>;
  /** Every row still running or owed, and the ones changed since `since` (epoch ms), newest first (H4's tree view). */
  recent?(since: number): Promise<Delegation[]>;
  owned(query: OwnedQuery): Promise<Delegation[]>;
  reportsSeen(ownerSession: string, messageIds: string[]): Promise<string[]>;
  bindChat(input: ChatBindInput): Promise<boolean>;
  /** The followed-brief rows (any state) behind briefs waiting in one chat's queue, by request id. */
  followedInto?(childSession: string, requestIds: string[]): Promise<Delegation[]>;
  /** Mark a running row stalled, or (no kind) clear its stall. */
  setStall?(input: StallInput): Promise<Change>;
  /** Its owner retried or split it: `task` is the new task taking it on (delegate_task `redoes`), kept in its log. */
  noteRedo?(ownerSession: string, id: string, task: string): Promise<Change>;
  /** Hivra WP-10: the depth a delegation from this chat would sit at; rejects past the cap, with the reason. */
  checkDepth?(ownerSession: string, opts?: { fanout?: boolean }): Promise<number>;
  /** Hivra WP-10: the first mate passes its worker's open question on to the person, or takes it back. */
  setQuestionOwner?(id: string, generation: number, owner: "person" | "first-mate", by?: string): Promise<Change>;
};

export const tauriDelegations: DelegationsBackend = {
  record: (input) => invoke("delegations_record", { input }),
  settle: (input) => invoke("delegations_settle", { input }),
  reattach: (childSession, resume, by) =>
    invoke("delegations_reattach", { childSession, resume, by }),
  setQuestion: (id, question, by, detail) =>
    invoke("delegations_set_question", { id, question, by, detail }),
  setDelivery: (input) => invoke("delegations_set_delivery", { input }),
  cancel: (ids, reason, by) => invoke("delegations_cancel", { ids, reason, by }),
  refuse: (id, by) => invoke("delegations_refuse", { id, by }),
  listOpen: () => invoke("delegations_list_open"),
  tree: (id) => invoke("delegations_tree", { id }),
  recent: (since) => invoke("delegations_recent", { since }),
  owned: (input) => invoke("delegations_owned", { input }),
  reportsSeen: (ownerSession, messageIds) =>
    invoke("delegations_reports_seen", { ownerSession, messageIds }),
  bindChat: (input) => invoke("delegations_bind_chat", { input }),
  followedInto: (childSession, requestIds) => invoke("delegations_followed_into", { childSession, requestIds }),
  setStall: (input) => invoke("delegations_set_stall", { input }),
  noteRedo: (ownerSession, id, task) => invoke("delegations_note_redo", { ownerSession, id, task }),
  checkDepth: (ownerSession, opts) =>
    invoke("firstmate_check_depth", {
      ownerSession,
      ...(opts?.fanout === false ? { fanout: false } : {}),
    }),
  setQuestionOwner: (id, generation, owner, by) =>
    invoke("firstmate_set_question_owner", { id, generation, owner, by }),
};

/** delegations.rs's event after any change to a row. */
export const DELEGATIONS_CHANGED = "monocode:delegations-changed";

/** Resolves on the next change to any row, or after `ms`, whichever comes first. */
export function nextDelegationChange(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let off: (() => void) | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off?.();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    void listen(DELEGATIONS_CHANGED, finish)
      .then((unlisten) => {
        if (done) unlisten();
        else off = unlisten;
      })
      .catch(() => undefined);
  });
}

export function isOpenDelegation(row: Pick<Delegation, "state">): boolean {
  return row.state === "running" || row.state === "question";
}

/** A report is still owed: the work runs, or it finished and its report hasn't reached the owner. */
export function isOwed(row: Pick<Delegation, "state" | "delivery">): boolean {
  return (
    isOpenDelegation(row) ||
    row.delivery === "pending" ||
    row.delivery === "queued"
  );
}

/** What the row's settle stores: the report's status, text and the provider's reason for a failure. */
export function settleInput(
  row: Pick<Delegation, "id" | "generation"> & { reviewRequired?: boolean },
  result: MonoSessionCompletionResult,
  by?: string,
): SettleInput {
  // The row is the durable truth about whether this report owes a self-review; a result built without that (an older
  // caller) is judged by it too, so no path settles a delegated report as done unchecked.
  const judged = withReviewBackstop(
    row.reviewRequired && !result.reviewRequired
      ? { ...result, reviewRequired: true }
      : result,
  );
  const resetsAt = judged.resetsAt ? Date.parse(judged.resetsAt) : NaN;
  return {
    id: row.id,
    generation: row.generation,
    state: judged.status,
    result: judged.result,
    ...(judged.reason || judged.error
      ? { error: judged.reason ?? judged.error }
      : {}),
    ...(judged.errorClass ? { errorClass: judged.errorClass } : {}),
    ...(judged.retryable !== undefined ? { retryable: judged.retryable } : {}),
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    ...(judged.review ? { selfReview: JSON.stringify(judged.review) } : {}),
    ...(by ? { by } : {}),
  };
}

/** The self-review part of a stored row's result: the accepted one, or the fact that one was owed and is missing. */
function reviewFields(
  row: Delegation,
): Pick<MonoSessionCompletionResult, "review" | "reviewRequired"> {
  const review = storedReview(row.selfReview);
  if (review) return { review, reviewRequired: true };
  return row.reviewRequired ? { reviewRequired: true } : {};
}

/** A finished row's report, rebuilt from what the row stored (its in-memory batch is gone). */
export function storedResult(
  row: Delegation,
  child?: Session | null,
): MonoSessionCompletionResult {
  const status = isOpenDelegation(row)
    ? "cancelled"
    : (row.state as MonoSessionCompletionResult["status"]);
  const prompt = row.brief ?? "";
  const result = row.result ?? "";
  const errorClass = isProviderErrorClass(row.errorClass)
    ? row.errorClass
    : undefined;
  const resetsAt =
    row.resetsAt != null && Math.abs(row.resetsAt) <= 8.64e15
      ? new Date(row.resetsAt).toISOString()
      : undefined;
  return {
    sessionId: row.childSession,
    // Where the work ran: the row's project is the hub project id when there is one (for Ash OS).
    project: child?.cwd ?? row.project ?? "",
    title: workerTitle(child?.title || row.title, "Agent session") || "Agent session",
    status,
    originalPrompt: prompt.slice(0, 12_000),
    result: result.slice(0, 12_000),
    truncated: result.length >= 12_000,
    ...reviewFields(row),
    ...(row.error ? { error: row.error } : {}),
    ...(status === "failed" && errorClass
      ? {
          errorClass,
          reason: failedReason(errorClass),
          ...(row.retryable != null ? { retryable: row.retryable } : {}),
          ...(resetsAt ? { resetsAt } : {}),
        }
      : {}),
  };
}

/** The report of a child that finished while nobody was listening: its last reply, or the error that ended it. */
export function transcriptResult(
  row: Delegation,
  child: Session,
): MonoSessionCompletionResult {
  const last = child.blocks[child.blocks.length - 1];
  const failed = last?.role === "system" && last.notice === "error";
  const outcome: ControlOutcome = failed
    ? { status: "failed", text: "", error: last.text }
    : { status: "completed", text: "" };
  return monoSessionCompletionResult({
    requestId: row.requestId,
    sessionId: child.id,
    project: child.cwd,
    prompt: row.brief ?? "",
    outcome,
    session: child,
    latestTurn: row.generation > 1,
    reviewRequired: row.reviewRequired,
  });
}

/** The ids a row's report may have gone out under: the message it was queued in, then its own receipt. */
export function reportIds(row: Delegation): string[] {
  const receipt = completionReceipt(row.requestId, row.generation);
  return [
    ...(row.deliveryMessage && row.deliveryMessage !== receipt
      ? [row.deliveryMessage]
      : []),
    receipt,
  ];
}

export type BootStep =
  /** Still running: its resumed turn re-attaches and reports. */
  | { kind: "wait" }
  /** Its owner is gone: nobody to report to. */
  | { kind: "drop"; reason: string }
  /** It finished (or its child vanished) while nobody listened: settle it, then report it. */
  | { kind: "settle"; result: MonoSessionCompletionResult }
  /** Its report already reached the owner. */
  | { kind: "delivered"; messageId: string }
  /** Its report waits in the owner's queue already. */
  | { kind: "queued"; messageId: string }
  /** Owed and nowhere: queue it, once. */
  | { kind: "queue"; messageId: string };

/**
 * What boot recovery does with one row. `owner` is the owner's chat (null when it is gone), `child` the child session
 * (null when it no longer exists), `seen` the report ids already in the owner's transcript.
 */
export function bootStep(
  row: Delegation,
  look: {
    owner: Session | null;
    child: Session | null;
    seen: ReadonlySet<string>;
  },
): BootStep {
  if (!look.owner) return { kind: "drop", reason: "Its owner is gone." };
  // A followed brief is reported by watching its chat (followedBriefs.ts), which also runs after a restart.
  if (row.follow && isOpenDelegation(row)) return { kind: "wait" };
  if (isOpenDelegation(row)) {
    if (!look.child)
      return {
        kind: "settle",
        result: {
          ...storedResult(row),
          status: "cancelled",
          error: "The session it was working in is gone.",
        },
      };
    if (look.child.busy || wasTurnInterrupted(look.child))
      return { kind: "wait" };
    return { kind: "settle", result: transcriptResult(row, look.child) };
  }
  const ids = reportIds(row);
  const seen = ids.find((id) => look.seen.has(id));
  if (seen) return { kind: "delivered", messageId: seen };
  const waiting = look.owner.queuedMessages?.find((message) =>
    ids.includes(message.id),
  );
  if (waiting) return { kind: "queued", messageId: waiting.id };
  return {
    kind: "queue",
    messageId: completionReceipt(row.requestId, row.generation),
  };
}

/** How long to wait before each further boot attempt; the last repeats. */
export const BOOT_RETRY_MS = [2_000, 5_000, 15_000, 60_000] as const;

/**
 * Boot until the open rows load: a failed load is tried again, further apart each time, while `live()`. Whether an
 * attempt also recovers is asked per attempt, so a recovery that failed is taken up by whichever attempt comes next.
 * Resolves true once loaded, false when it stopped because the window went.
 */
export async function bootUntilLoaded(
  tracker: Pick<DelegationTracker, "boot">,
  options: {
    live(): boolean;
    recover(): boolean;
    /** After each attempt, with whether it recovered and whether the rows loaded. */
    attempted?(outcome: { recover: boolean; loaded: boolean }): void;
    wait?(ms: number): Promise<void>;
  },
): Promise<boolean> {
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; options.live(); attempt++) {
    const recover = options.recover();
    try {
      await tracker.boot(recover);
      options.attempted?.({ recover, loaded: true });
      return true;
    } catch (error) {
      console.error("Could not load the open delegations; trying again", error);
      options.attempted?.({ recover, loaded: false });
    }
    if (!options.live()) break;
    await wait(BOOT_RETRY_MS[Math.min(attempt, BOOT_RETRY_MS.length - 1)]);
  }
  return false;
}

/** What the tracker needs from the app. */
export type DelegationHost = {
  /** A session as this window has it. */
  session(id: string): Session | undefined;
  /** A session as this window has it, else as stored; null when it no longer exists. */
  load(id: string): Promise<Session | null>;
  /** The owner's chat opened here to take a report; null when it is gone. */
  openOwner(id: string): Promise<Session | null>;
  isMono(id: string): boolean;
  /** Put a report in the owner's queue (it is deduplicated by its id). */
  queueReport(ownerId: string, message: QueuedMessage): Promise<void>;
  /** A quit cuts turns short: their rows stay running and their resumed turns report. */
  quitting(): boolean;
  /** r84: a resumed worker's finished changes put into the project (workerLanding.ts); the report says what happened. */
  land?(result: MonoSessionCompletionResult): Promise<MonoSessionCompletionResult>;
  /**
   * WP-13: an account failure is recorded. The note can name the next signed-in CLI. A usage limit is not
   * settled here; the row stays open and the app notes the pause on its own.
   */
  crewFailure?(row: Delegation, result: MonoSessionCompletionResult): Promise<CrewFailureNote | undefined>;
};

/** One monitored launch or follow-up. */
export type DelegationLaunch = {
  /** The stored row (null when the store refused it; the in-memory batch still reports). */
  row: Promise<Delegation | null>;
  /** The child's turn ended. The batch cache queues the report; this keeps the row in step. The crew note, if one was recorded. */
  settle(result: MonoSessionCompletionResult): Promise<CrewFailureNote | undefined>;
  /** The CLI refused the launch and the calling turn already heard why: nothing is owed. */
  refuse(): void;
};

/** Watches a turn that may resume delegated work. */
export type ResumeMonitor = {
  started(): void;
  settled(outcome: ControlOutcome): void;
};

export type BootSummary = Record<BootStep["kind"], number>;

const key = (owner: string, request: string) => `${owner}\u0000${request}`;

/**
 * A row this window still needs: one whose work runs or whose report is owed, and a Lead's report that reached its
 * owner until its room post is done (`forget`). A settled row whose report was delivered, acknowledged or thrown away
 * is let go, so a long-running window doesn't keep every row it ever saw.
 */
function retained(row: Delegation): boolean {
  return (
    isOwed(row) ||
    (row.follow === "lead" && row.delivery !== "disposed" && !!row.deliveryMessage)
  );
}

/** The app's side of the delegation rows: one instance per window, every store call in order. */
export class DelegationTracker {
  private tail: Promise<unknown> = Promise.resolve();
  private rows = new Map<string, Delegation>();
  private requests = new Map<string, string>();
  private openChildren = new Map<string, string>();
  private binds = new Map<string, string>();
  private loaded = false;

  constructor(
    private backend: DelegationsBackend,
    private host: DelegationHost,
  ) {}

  /** Store calls run one at a time, in the order they were asked for, so a settle never overtakes its record. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private remember(row: Delegation | null | undefined) {
    if (!row) return;
    if (retained(row)) {
      this.rows.set(row.id, row);
      this.requests.set(key(row.ownerSession, row.requestId), row.id);
    } else this.forget(row.id);
    // A followed brief never re-attaches to a turn in its chat (the watcher reports it), so it isn't "the row this
    // chat works for" either.
    if (isOpenDelegation(row) && !row.follow) this.openChildren.set(row.childSession, row.id);
    else if (this.openChildren.get(row.childSession) === row.id)
      this.openChildren.delete(row.childSession);
  }

  /** Let go of a row this window no longer needs (a Lead's report once its room post is done). */
  forget(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.delete(id);
    const request = key(row.ownerSession, row.requestId);
    if (this.requests.get(request) === id) this.requests.delete(request);
  }

  /** The followed briefs still open (followedBriefs.ts watches their chats). */
  openFollowed(): Delegation[] {
    return [...this.rows.values()].filter((row) => !!row.follow && isOpenDelegation(row));
  }

  /** Every row this window knows. */
  known(): Delegation[] {
    return [...this.rows.values()];
  }

  /** A followed brief is done: settle it and queue its report to the owner, once (its receipt dedupes). */
  settleFollowed(row: Delegation, result: MonoSessionCompletionResult, by = "watch"): Promise<boolean> {
    return this.serial(async () => {
      const change = await this.backend.settle(settleInput(row, result, by));
      this.remember(change.row);
      if (change.applied && change.row) await this.report(change.row, result);
      return change.applied;
    });
  }

  /** A followed brief that can't go on (taken out of the queue, its chat gone): cancelled, its owner told nothing. */
  cancelFollowed(row: Delegation, reason: string, by = "watch"): Promise<void> {
    return this.serial(async () => {
      for (const entry of await this.backend.cancel([row.id], reason, by)) this.remember(entry);
    });
  }

  /** Refresh one row from the store (another window, or the Rust side, may have moved it). */
  refresh(ids: string[], ownerSession: string): Promise<Delegation[]> {
    return this.serial(async () => {
      const rows = await this.backend.owned({ ownerSession, ids });
      rows.forEach((row) => this.remember(row));
      return rows;
    });
  }

  /** The rows still running or owed are loaded (boot), so `openRowFor` is complete. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** A row this window knows, by id. */
  row(id: string): Delegation | undefined {
    return this.rows.get(id);
  }

  /** The open delegation a session is working for, if any. */
  openRowFor(childSession: string): Delegation | undefined {
    const id = this.openChildren.get(childSession);
    return id ? this.rows.get(id) : undefined;
  }

  /** Record a monitored launch or follow-up before its child starts. */
  launch(input: RecordInput): DelegationLaunch {
    // r63: the row's title is a job name, not the Lead's "I'll check…" (workerTitle.ts).
    if (input.title) input = { ...input, title: workerTitle(input.title, input.title) };
    const row = this.serial(async () => {
      const recorded = await this.backend.record(input);
      this.remember(recorded);
      return recorded;
    }).catch((error: unknown) => {
      console.error("Could not record the delegation", error);
      return null;
    });
    return {
      row,
      settle: (result) =>
        this.serial(async () => {
          const recorded = await row;
          if (!recorded || this.host.quitting()) return;
          const change = await this.backend.settle(
            settleInput(recorded, result),
          );
          this.remember(change.row);
          // WP-13: an account failure that landed is recorded. The note can name the next signed-in CLI.
          if (change.applied && change.row && result.status === "failed" && this.host.crewFailure)
            return await this.host.crewFailure(change.row, result);
          return undefined;
        }).catch((error: unknown) => {
          console.error("Could not settle the delegation", error);
          return undefined;
        }),
      refuse: () => {
        void this.serial(async () => {
          const recorded = await row;
          if (!recorded) return;
          this.remember((await this.backend.refuse(recorded.id)).row);
        }).catch(() => undefined);
      },
    };
  }

  /**
   * The batch cache is about to queue one message with these requests' reports. Recording where they wait comes
   * first: if the app dies before the queue is saved, boot finds the message missing and queues the report again.
   */
  queued(
    ownerId: string,
    requestIds: string[],
    messageId: string,
  ): Promise<void> {
    return this.serial(async () => {
      const ids = requestIds.flatMap((request) => {
        const id = this.requests.get(key(ownerId, request));
        return id ? [id] : [];
      });
      if (!ids.length) return;
      for (const row of await this.backend.setDelivery({
        ids,
        delivery: "queued",
        queuedMessage: messageId,
      }))
        this.remember(row);
    }).catch((error: unknown) =>
      console.error("Could not mark the report queued", error),
    );
  }

  /** A report went to its owner as a turn. */
  delivered(messageId: string): void {
    if (!messageId.startsWith("mono-completion-")) return;
    void this.serial(async () => {
      for (const row of await this.backend.setDelivery({
        messageId,
        delivery: "delivered",
      }))
        this.remember(row);
    }).catch(() => undefined);
  }

  /** Ash removed a report from the owner's queue himself: it is not owed any more. */
  discarded(messageId: string): void {
    if (!messageId.startsWith("mono-completion-")) return;
    void this.serial(async () => {
      for (const row of await this.backend.setDelivery({
        messageId,
        delivery: "disposed",
        by: "user",
      }))
        this.remember(row);
    }).catch(() => undefined);
  }

  /** The owner stopped, archived or deleted its child (or cancelled its task): the work is cancelled and no report follows. */
  stopOwned(
    ownerId: string,
    childSession: string,
    reason = "Stopped by its owner.",
  ): Promise<void> {
    return this.serial(async () => {
      const ids = [...this.rows.values()]
        .filter(
          (row) =>
            row.ownerSession === ownerId &&
            row.childSession === childSession &&
            isOwed(row),
        )
        .map((row) => row.id);
      if (!ids.length) return;
      for (const row of await this.backend.cancel(
        ids,
        reason,
        `owner:${ownerId}`,
      ))
        this.remember(row);
    }).catch(() => undefined);
  }

  /**
   * The owner cancelled these tasks (task_cancel), or a Stop reached them (stopTree.ts): what is still owed is
   * cancelled, with its reason and who acted (the owner unless `by` says, such as `user` for Ash's Stop).
   */
  cancelOwned(
    ownerId: string,
    rows: Delegation[],
    reason: string,
    by = `owner:${ownerId}`,
  ): Promise<Delegation[]> {
    return this.serial(async () => {
      const ids = rows
        .filter((row) => row.ownerSession === ownerId && isOwed(row))
        .map((row) => row.id);
      if (!ids.length) return [];
      const changed = await this.backend.cancel(ids, reason, by);
      changed.forEach((row) => this.remember(row));
      return changed;
    });
  }

  /**
   * A worker's question reached its row (state question, with the question), or it was answered (null): through the
   * tracker, so this window's open rows stay in step. Only an open row moves (delegations.rs).
   */
  setQuestion(
    row: Pick<Delegation, "id">,
    question: string | null,
    by: string,
    detail?: Record<string, unknown>,
  ): Promise<Change> {
    return this.serial(async () => {
      const change = await this.backend.setQuestion(row.id, question, by, detail);
      this.remember(change.row);
      return change;
    });
  }

  /**
   * The stall watcher judged a running row (workerStall.ts): stalled this way, or (null) moving again. Through the
   * tracker, so this window's open rows stay in step; a backend without stalls changes nothing.
   */
  setStall(
    row: Pick<Delegation, "id" | "generation">,
    stall: { kind: StallKind; reason: string; since: number } | null,
    by = "watch",
  ): Promise<Change> {
    const write = this.backend.setStall?.bind(this.backend);
    if (!write) return Promise.resolve({ applied: false, row: null });
    return this.serial(async () => {
      const change = await write({
        id: row.id,
        generation: row.generation,
        ...(stall ? { kind: stall.kind, reason: stall.reason, since: stall.since } : {}),
        by,
      });
      this.remember(change.row);
      return change;
    });
  }

  /** Its owner retried or split this task with `task` (delegate_task `redoes`): kept on the row for its card. */
  noteRedo(ownerId: string, row: Pick<Delegation, "id">, task: string): Promise<void> {
    const write = this.backend.noteRedo?.bind(this.backend);
    if (!write) return Promise.resolve();
    return this.serial(async () => {
      const change = await write(ownerId, row.id, task);
      this.remember(change.row);
    });
  }

  /**
   * The owner read these finished results inside its own turn (task_status, a wait-mode delegate_task): they count as
   * received, so no report turn follows for them (T3's "a status read acknowledges").
   */
  acknowledge(ownerId: string, ids: string[]): Promise<Delegation[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.serial(async () => {
      const changed = await this.backend.setDelivery({
        ids,
        delivery: "acknowledged",
        by: `owner:${ownerId}`,
      });
      changed.forEach((row) => this.remember(row));
      return changed;
    });
  }

  /**
   * A turn is about to start in `sessionId`. When it may pick delegated work back up (it resumes a cut-off turn, or
   * the session is the child of an open row), watch it: it re-attaches when it starts and reports when it ends.
   */
  resumeMonitor(
    sessionId: string,
    text: string,
    busy: boolean,
    /** The turn resumes a cut-off one (an automatic resume's text carries a note, so the caller says). */
    resume: boolean = text.trim() === CONTINUE_PROMPT,
  ): ResumeMonitor | undefined {
    if (busy) return undefined;
    if (!resume && this.loaded && !this.openChildren.has(sessionId))
      return undefined;
    let attached: Promise<Delegation | null> | undefined;
    return {
      started: () => {
        if (attached) return;
        attached = this.serial(async () => {
          // Before the open rows are loaded the store decides (a plain turn only picks up an open row).
          if (!resume && this.loaded && !this.openChildren.has(sessionId))
            return null;
          const row = await this.backend.reattach(
            sessionId,
            resume,
            resume ? "resume" : "user",
          );
          this.remember(row);
          return row;
        }).catch(() => null);
      },
      settled: (outcome) => {
        const pending = attached;
        if (!pending) return;
        void this.serial(async () => {
          const row = await pending;
          if (!row || this.host.quitting()) return;
          const result = monoSessionCompletionResult({
            requestId: row.requestId,
            sessionId: row.childSession,
            project:
              this.host.session(row.childSession)?.cwd ?? row.project ?? "",
            prompt: row.brief ?? "",
            outcome,
            session: this.host.session(row.childSession),
            latestTurn: true,
            // r84 (s14 blind 3): a resumed job's report is read for its self-review too, or a checked report settles
            // failed as "without a self-review".
            ...(row.reviewRequired ? { reviewRequired: true } : {}),
          });
          const landed = this.host.land ? await this.host.land(result).catch(() => result) : result;
          const change = await this.backend.settle(settleInput(row, landed));
          this.remember(change.row);
          if (change.applied && change.row)
            await this.report(change.row, landed);
        }).catch((error: unknown) =>
          console.error("Could not report the resumed delegation", error),
        );
      },
    };
  }

  /** Queue one row's report under its receipt. Only inside a serial job. */
  private async report(row: Delegation, result: MonoSessionCompletionResult) {
    // Settling and reporting both judge the self-review here, so a report settled as failed for a missing one never
    // reaches the Lead as a done result (the settle already carries the same downgrade).
    const message = completionMessage(
      completionReceipt(row.requestId, row.generation),
      [withReviewBackstop(result)],
    );
    const already =
      row.delivery === "queued" && row.deliveryMessage === message.id;
    const changed = await this.backend.setDelivery({
      ids: [row.id],
      delivery: "queued",
      queuedMessage: message.id,
    });
    changed.forEach((entry) => this.remember(entry));
    if (!changed.length && !already) return;
    await this.host.queueReport(row.ownerSession, message);
  }

  /**
   * Load the rows still running or owed. In the one window that recovers (`recover`), act on each: queue a finished
   * report once, settle a child that finished or vanished, drop rows whose owner is gone, and leave running ones to
   * their resumed turns.
   */
  async boot(recover: boolean): Promise<BootSummary> {
    const summary: BootSummary = {
      wait: 0,
      drop: 0,
      settle: 0,
      delivered: 0,
      queued: 0,
      queue: 0,
    };
    // Loaded only when they were: until then a chat's next turn asks the store whether it works for an open row
    // (resumeMonitor), so a failed load never leaves a child unable to re-attach. bootUntilLoaded tries again.
    const rows = await this.serial(() => this.backend.listOpen());
    rows.forEach((row) => this.remember(row));
    this.loaded = true;
    if (!recover) return summary;
    for (const listed of rows) {
      await this.serial(async () => {
        const row = this.rows.get(listed.id) ?? listed;
        if (!isOwed(row)) return;
        const mono = this.host.isMono(row.ownerSession);
        const owner = mono ? await this.host.openOwner(row.ownerSession) : null;
        // A Mono whose chat can't be opened right now keeps its rows for the next boot.
        if (mono && !owner) return;
        const child = owner ? await this.host.load(row.childSession) : null;
        const seen = owner
          ? new Set(
              await this.backend.reportsSeen(row.ownerSession, reportIds(row)),
            )
          : new Set<string>();
        const step = bootStep(row, { owner, child, seen });
        summary[step.kind]++;
        await this.apply(row, step);
      }).catch((error: unknown) =>
        console.error("Could not recover a delegation", error),
      );
    }
    return summary;
  }

  /** Carry out one boot step. Only inside a serial job. */
  private async apply(row: Delegation, step: BootStep) {
    switch (step.kind) {
      case "wait":
        return;
      case "drop":
        for (const entry of await this.backend.cancel(
          [row.id],
          step.reason,
          "boot",
        ))
          this.remember(entry);
        return;
      case "settle": {
        const change = await this.backend.settle(
          settleInput(row, step.result, "boot"),
        );
        this.remember(change.row);
        if (change.applied && change.row)
          await this.report(change.row, step.result);
        return;
      }
      case "delivered":
        for (const entry of await this.backend.setDelivery({
          ids: [row.id],
          delivery: "delivered",
          by: "boot",
        }))
          this.remember(entry);
        return;
      case "queued":
        if (row.delivery === "queued" && row.deliveryMessage === step.messageId)
          return;
        for (const entry of await this.backend.setDelivery({
          ids: [row.id],
          delivery: "queued",
          queuedMessage: step.messageId,
          by: "boot",
        }))
          this.remember(entry);
        return;
      case "queue":
        await this.report(
          row,
          storedResult(row, await this.host.load(row.childSession)),
        );
    }
  }

  /** Tell Ash OS which chat a Claude session is (only when that changed). */
  bindChat(input: ChatBindInput): void {
    const signature = JSON.stringify([
      input.chatId,
      input.monoId ?? null,
      input.role ?? null,
      input.delegationId ?? null,
    ]);
    if (this.binds.get(input.providerSession) === signature) return;
    this.binds.set(input.providerSession, signature);
    void this.backend.bindChat(input).catch(() => {
      this.binds.delete(input.providerSession);
    });
  }
}
