// Self-repair (board H3; Ash, 14 Oct: "errors the harness can see get fixed without Ash asking"). Kept on 21 Oct when
// the folder-reading hourly judge went (the hourly check is now one line to the owner, hourlyCheck.ts).
//
// A worker that crashed (a passing provider fault or its process dying, its Lead not yet told) or hung (the stall
// watcher marked it quiet while busy, or idle without reporting back) is retried with backoff: 1, 5, then 15 minutes
// after it went wrong. A hung busy worker is nudged first and restarted after; the rest are continued. After three tries
// it is left stuck ("Crashed 4 times, retries gave up") and its Lead is told to handle it. A fault only starts over once
// the worker has run cleanly for half an hour, so a crash loop can't be retried for ever. A question, a usage limit, a
// billing or sign-in refusal, and anything Ash stopped are never retried. It reads no folders and runs no model.
import { isProviderErrorClass } from "../../../integrations/harness/core/providerFailure";
import { CONTINUE_PROMPT } from "../../sessions/model/inFlight";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import type { Delegation, DelegationTracker } from "./delegations";
import type { Stall } from "./workerStall";

const MIN = 60_000;
/** How long a repaired worker must run cleanly before a later fault gets fresh tries. */
const RESET_MS = 30 * MIN;
/** The wait before each try, from when it went wrong; its length is the number of tries. */
export const REPAIR_BACKOFF_MS: readonly number[] = [MIN, 5 * MIN, 15 * MIN];

type WorkerChat = Pick<Session, "busy" | "pendingQuestion" | "usageLimit">;

export type RepairHost = {
  tracker(): DelegationTracker | null;
  session(id: string): WorkerChat | undefined;
  /** A private note into the Lead's (owner's) chat, as an app notification, never as Ash. */
  tellLead(row: Delegation, text: string): void | Promise<void>;
  /** A message into the worker's chat: it steers a running turn, or starts the next one. */
  message(row: Delegation, text: string): Promise<boolean>;
  /** Stop the worker's running turn (its own chat only), before it is continued: a restart for a hung worker. */
  stopTurn(row: Delegation): Promise<boolean>;
  /** Its unread failure report won't be needed (it is being retried): out of the Lead's queue. */
  dropReport?(row: Delegation): void;
  now?(): number;
  backoffMs?: readonly number[];
};

type Repair = { episode: string; tries: number; nextAt: number; gaveUp: boolean; okSince?: number; restarting?: boolean; verdict?: Stall };

const NUDGE = "Check-in from the app: there's been no output for a while. If a command is stuck, stop it and carry on, and say where you are.";
const titleOf = (row: Delegation) => (row.title || "Delegated work").trim();
const short = (text: string, max = 100) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const lowerFirst = (text: string) => (text[0] && text[1] && text[1] === text[1].toLowerCase() ? text[0].toLowerCase() + text.slice(1) : text);

/** A failure the app may retry by itself: a passing provider fault or the process dying, never a refusal or a limit. */
export function repairableFailure(row: Pick<Delegation, "state" | "errorClass" | "error" | "retryable" | "delivery">): boolean {
  if (row.state !== "failed" || row.retryable === false) return false;
  // Its Lead already read the failure: what happens next is the Lead's call.
  if (row.delivery === "delivered" || row.delivery === "acknowledged" || row.delivery === "disposed") return false;
  if (isProviderErrorClass(row.errorClass)) return row.errorClass === "overloaded" || row.errorClass === "provider_error";
  return /\b(exited|crash(ed)?|killed|signal|broken pipe|ECONNRESET|socket hang up|terminated|timed out)\b/i.test(row.error ?? "");
}

/** What self-repair saw before it gave up, in plain words: "Crashed 4 times, retries gave up: Claude exited with code 1". */
export function gaveUpReason(row: Pick<Delegation, "state" | "stallKind" | "errorClass" | "error">, times: number): string {
  if (row.state === "running")
    return row.stallKind === "idle" ? `Stopped without reporting back ${times} times, retries gave up` : `Went quiet ${times} times, retries gave up`;
  const what = row.errorClass === "overloaded" ? "Provider overloaded" : row.errorClass === "provider_error" ? "Provider failed" : "Crashed";
  const error = row.error?.trim().split("\n")[0];
  return `${what} ${times} times, retries gave up${error && what === "Crashed" ? `: ${short(error, 120)}` : ""}`;
}

/** The Lead's private note: a hidden app turn that shows as one quiet line ("From Self-repair"), never as Ash's words. */
export function repairNoteMessage(row: Pick<Delegation, "id" | "childSession">, text: string, at: number): QueuedMessage {
  return {
    id: `self-repair-${row.id}-${Math.floor(at / MIN)}`,
    attachments: [],
    monoNote: { kind: "message", from: "Self-repair", line: text.length > 160 ? `${text.slice(0, 159)}…` : text },
    text: `[MonoCode self-repair] ${text} (worker chat ${row.childSession}; this is the app, not Ash.)`,
  };
}

/** One per main window, on the stall watcher's half-minute look. `stallFor` is the line it holds once it gave up. */
export class SelfRepair {
  private repairs = new Map<string, Repair>();
  private seen = new Set<string>();
  private running = false;

  constructor(private host: RepairHost) {}

  private now() {
    return (this.host.now ?? Date.now)();
  }

  stallFor(row: Pick<Delegation, "id">): Stall | null {
    return this.repairs.get(row.id)?.verdict ?? null;
  }

  /** Tests: what it last made of a row. */
  state(rowId: string): Readonly<Repair> | undefined {
    return this.repairs.get(rowId);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tracker = this.host.tracker();
      if (!tracker?.isLoaded()) return;
      const rows = tracker.known();
      // A worker mid-restart reads cancelled for a moment (its turn was stopped): it stays watched until it's continued.
      const live = new Set(rows.filter((r) => r.state === "running" || r.state === "failed" || this.repairs.get(r.id)?.restarting).map((r) => r.id));
      for (const id of this.repairs.keys()) if (!live.has(id)) this.repairs.delete(id);
      for (const id of this.seen) if (!live.has(id)) this.seen.delete(id);
      for (const row of rows) {
        if (!live.has(row.id)) continue;
        try {
          await this.look(row);
        } catch (error) {
          console.error("Self-repair could not look at a worker", error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async look(row: Delegation) {
    const chat = this.host.session(row.childSession);
    if (!chat) return; // Not this window's.
    if (!this.seen.has(row.id)) {
      // A failure seen before it ever ran here is its Lead's.
      if (row.state === "running") this.seen.add(row.id);
      return;
    }
    const now = this.now();
    const backoff = this.host.backoffMs ?? REPAIR_BACKOFF_MS;
    const existing = this.repairs.get(row.id);
    if (existing?.restarting) {
      if (chat.busy) return; // The stop hasn't landed yet.
      existing.restarting = false;
      await this.continueIt(row);
      return;
    }
    let episode: string | undefined;
    let wentWrongAt = now;
    let how: "continue" | "nudge" = "continue";
    if (row.state === "failed" && repairableFailure(row)) {
      episode = `failed:${row.errorClass ?? ""}:${row.error ?? ""}`;
      wentWrongAt = row.settledAt ?? row.updatedAt;
    } else if (row.state === "running" && (row.stallKind === "quiet" || row.stallKind === "idle") && !chat.pendingQuestion && !chat.usageLimit) {
      episode = `stall:${row.stallKind}`;
      wentWrongAt = row.stalledAt ?? row.updatedAt;
      how = row.stallKind === "quiet" && chat.busy ? "nudge" : "continue";
    }
    if (!episode) {
      // Working again: after half an hour of it, a later fault starts over (a crash loop never does).
      if (existing && row.state === "running" && !row.stallKind) {
        existing.okSince ??= now;
        if (now - existing.okSince >= RESET_MS) this.repairs.delete(row.id);
      }
      return;
    }
    const r = existing ?? { episode, tries: 0, nextAt: wentWrongAt + backoff[0], gaveUp: false };
    this.repairs.set(row.id, r);
    if (r.episode !== episode) {
      // A new fault in the same run: it waits its own backoff, and the tries carry on counting.
      r.episode = episode;
      r.nextAt = Math.max(r.nextAt, wentWrongAt + (backoff[Math.min(r.tries, backoff.length - 1)] ?? 0));
    }
    delete r.okSince;
    if (r.gaveUp || now < r.nextAt) return;
    if (r.tries >= backoff.length) {
      r.gaveUp = true;
      const reason = gaveUpReason(row, r.tries + 1);
      // Its stall line now says what happened, over the watcher's minutes-scale one.
      if (row.state === "running") r.verdict = { kind: "loop", reason, since: wentWrongAt, final: true };
      await this.host.tellLead(
        row,
        `"${titleOf(row)}": ${lowerFirst(reason)}. Handle it yourself, without asking Ash: retry it differently or split it (delegate_task with redoes "${row.id}"), or stop it (task_cancel ${row.id}), then say in one line here what you did. Only if the fix needs something only Ash can give (a key or sign-in, a delete, or a money decision), tell him in one plain line here the one thing you need.`,
      );
      return;
    }
    r.tries++;
    r.nextAt = now + (backoff[r.tries] ?? backoff[backoff.length - 1]);
    if (how === "nudge" && r.tries === 1) {
      await this.host.message(row, NUDGE).catch(() => false);
      return;
    }
    if (chat.busy) {
      // A restart: stop its turn now, continue it on the next look, once the stop has settled its row.
      r.restarting = true;
      await this.host.stopTurn(row).catch(() => false);
      return;
    }
    await this.continueIt(row);
  }

  /** Continue a worker: its failure (or a restart's stop) report isn't needed by its Lead any more. */
  private async continueIt(row: Delegation) {
    if (row.state !== "running") this.host.dropReport?.(row);
    await this.host.message(row, CONTINUE_PROMPT).catch(() => false);
  }
}
