// Which delegated workers are stuck, and how (H4; Ash 20 Oct: "easy to see when a subagent is stuck both from the main
// agent and from other parts of the UI, being able to respond quickly or go into the chat"). One reading of the
// delegation rows for every surface: the Lead's chat (a card per stuck worker), the Monos rail (a mark on the Mono, a
// split "2 working · 1 stuck"), Being built (a job with a stuck worker under it reads Stuck, whatever its siblings do),
// Today, and the native notification.
//
// Stuck is one of:
// - asking: the worker asked its Lead (state `question`). Flagged everywhere at once; the Lead answers it when Ash's
//   words cover it. Once it has sat `ASK_ESCALATE_MS` unanswered it is Ash's too (`escalated`).
// - stalled: running, but quiet, looping or idle without a report (workerStall.ts writes it on the row).
// - failed: the work ended in a failure, with its reason (a usage limit with its reset time, a billing refusal: never
//   silently). It stays until Ash dismisses it, a later try in the same chat replaces it, or six hours pass.
// Stopped (cancelled) work is not stuck: someone stopped it on purpose.
import { useSyncExternalStore } from "react";
import { isProviderErrorClass, PROVIDER_ERROR_LABEL } from "../../../integrations/harness/core/providerFailure";
import { isOpenDelegation, type Delegation } from "./delegations";
import { batchRollup, CHILD_CHATS_RECENT_MS, type RollupState } from "./delegationView";

export type StuckKind = "asking" | "stalled" | "failed";

export type StuckWorker = {
  row: Delegation;
  kind: StuckKind;
  /** What to read: the question, why it failed, or how it stalled ("No output for 9 min · still running npm test"). */
  line: string;
  /** Since when it has been stuck this way, epoch ms. */
  since: number;
  /** Ash's beyond the Lead's chat (a notification, his to answer): failed, stalled, or a question left a few minutes. */
  escalated: boolean;
  /** Stable for one episode of being stuck: dismissals and notifications are keyed by it. */
  key: string;
};

/** How long a worker's question may wait on its Lead before it is Ash's to answer too. */
export const ASK_ESCALATE_MS = 3 * 60_000;
const FAILED_RECENT_MS = CHILD_CHATS_RECENT_MS;
const URGENCY: Record<StuckKind, number> = { failed: 0, stalled: 1, asking: 2 };

// ---- dismissed failures (per viewer, this Mac) --------------------------------------------------------------------------

const DISMISSED_KEY = "monocode:stuck-dismissed";
let dismissed: Set<string> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function dismissedKeys(): Set<string> {
  if (dismissed) return dismissed;
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    dismissed = new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []);
  } catch {
    dismissed = new Set();
  }
  return dismissed;
}

/** Ash has seen this failure: it leaves every surface (the Lead already has its report). */
export function dismissStuck(key: string): void {
  const keys = dismissedKeys();
  if (keys.has(key)) return;
  keys.add(key);
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...keys].slice(-200)));
  } catch {
    /* kept for this run */
  }
  version++;
  listeners.forEach((listener) => listener());
}

export function useStuckDismissalsVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}

/** Tests: forget every dismissal. */
export function resetStuckDismissals(): void {
  dismissed = new Set();
  try {
    localStorage.removeItem(DISMISSED_KEY);
  } catch {
    /* nothing stored */
  }
  version++;
}

// ---- words ---------------------------------------------------------------------------------------------------------------

function minutes(ms: number): string {
  const min = Math.max(1, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const rest = min % 60;
  return rest ? `${Math.floor(min / 60)} h ${rest} min` : `${Math.floor(min / 60)} h`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

const lowerFirst = (text: string) => (text[0] && text[1] && text[1] === text[1].toLowerCase() ? text[0].toLowerCase() + text.slice(1) : text);

/** "Failed: usage limit reached, resets 3:10pm", "Failed: billing refused", "Failed: the build broke". */
export function failureLine(row: Pick<Delegation, "errorClass" | "error" | "resetsAt">): string {
  if (isProviderErrorClass(row.errorClass)) {
    const reset = row.errorClass === "usage_limit" && row.resetsAt ? clock(row.resetsAt) : "";
    return `Failed: ${PROVIDER_ERROR_LABEL[row.errorClass]}${reset ? `, resets ${reset}` : ""}`;
  }
  const first = (row.error ?? "").trim().split(/(?<=[.!?])\s/)[0]?.replace(/[.!?\s]+$/, "") ?? "";
  const words = first.length > 140 ? `${first.slice(0, 140).replace(/\s+\S*$/, "")}…` : first;
  return `Failed: ${words ? lowerFirst(words) : "it stopped without saying why"}`;
}

/** How a stalled worker is stuck, with how long ("No output for 9 min · still running npm test"). */
export function stallLine(row: Pick<Delegation, "stallKind" | "stallReason" | "stalledAt">, now: number): string {
  const since = row.stalledAt ?? now;
  const reason = row.stallReason?.trim() ?? "";
  switch (row.stallKind) {
    case "quiet":
      return `No output for ${minutes(now - since)}${reason ? ` · ${lowerFirst(reason)}` : ""}`;
    case "loop":
      return reason || "Repeating the same step";
    case "idle":
      return `${reason || "Stopped without reporting back"} · ${minutes(now - since)} ago`;
    default:
      return reason || "Stuck";
  }
}

/** When a row's question was asked: its newest `asked` log line, else its last change. */
function askedAt(row: Delegation): number {
  for (let i = row.log.length - 1; i >= 0; i--) {
    const entry = row.log[i];
    if (entry.event === "asked" && typeof entry.at === "number") return entry.at;
  }
  return row.updatedAt;
}

// ---- reading the rows -----------------------------------------------------------------------------------------------------

/** Each child chat's newest row: a later try in the same chat replaces an earlier one. */
function newestPerChild(rows: readonly Delegation[]): Delegation[] {
  const latest = new Map<string, Delegation>();
  for (const row of rows) {
    const known = latest.get(row.childSession);
    if (!known || row.createdAt > known.createdAt) latest.set(row.childSession, row);
  }
  return [...latest.values()];
}

/** One row as stuck, or not. */
export function stuckOf(row: Delegation, now: number): StuckWorker | undefined {
  let kind: StuckKind;
  let since: number;
  let line: string;
  if (row.state === "question") {
    kind = "asking";
    since = askedAt(row);
    line = row.pendingQuestion?.trim() || "Asked its Lead a question";
  } else if (row.state === "running" && row.stallKind) {
    kind = "stalled";
    since = row.stalledAt ?? row.updatedAt;
    line = stallLine(row, now);
  } else if (row.state === "failed") {
    since = row.settledAt ?? row.updatedAt;
    if (now - since > FAILED_RECENT_MS) return undefined;
    kind = "failed";
    line = failureLine(row);
  } else return undefined;
  const key = `${row.id}:${kind}:${row.generation}:${since}`;
  if (kind === "failed" && dismissedKeys().has(key)) return undefined;
  return {
    row,
    kind,
    line,
    since,
    escalated: kind !== "asking" || now - since >= ASK_ESCALATE_MS,
    key,
  };
}

/** Every stuck worker, oldest first. */
export function stuckWorkers(rows: readonly Delegation[], now: number): StuckWorker[] {
  return newestPerChild(rows)
    .flatMap((row) => stuckOf(row, now) ?? [])
    .sort((a, b) => a.since - b.since);
}

/** The stuck workers a chat delegated itself. */
export function stuckOwnedBy(ownerSession: string, rows: readonly Delegation[], now: number): StuckWorker[] {
  return stuckWorkers(
    rows.filter((row) => row.ownerSession === ownerSession),
    now,
  );
}

export type WorkCounts = { working: number; asking: number; stuck: number };

/** What a chat has out: working, asking its Lead, and stuck (stalled or failed). */
export function workCounts(ownerSession: string, rows: readonly Delegation[], now: number): WorkCounts {
  return countWork(
    rows.filter((entry) => entry.ownerSession === ownerSession),
    now,
  );
}

/** The same count over any set of rows (a Mono's, across the chats it has had). */
export function countWork(rows: readonly Delegation[], now: number): WorkCounts {
  const counts: WorkCounts = { working: 0, asking: 0, stuck: 0 };
  for (const row of newestPerChild(rows)) {
    const stuck = stuckOf(row, now);
    if (stuck?.kind === "asking") counts.asking++;
    else if (stuck) counts.stuck++;
    else if (row.state === "running") counts.working++;
  }
  return counts;
}

/** "2 working · 1 asking · 1 stuck", or nothing when nothing is out. */
export function workSplit(counts: WorkCounts): string | undefined {
  const parts = [
    counts.working ? `${counts.working} working` : "",
    counts.asking ? `${counts.asking} asking` : "",
    counts.stuck ? `${counts.stuck} stuck` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** A row's rollup word: a stalled one is stuck whatever its live chat shows. */
export function rollupState(row: Delegation): RollupState {
  if (row.state === "running") return row.stallKind ? "stuck" : "working";
  if (row.state === "question") return "input";
  if (row.state === "completed") return "done";
  if (row.state === "failed") return "failed";
  return "stopped";
}

/**
 * A Lead's line over the work it has out now: "Delegated 3: 2 working, 1 failed". The wave is what still runs, what
 * finished since the oldest of it started, and any failure still stuck. Nothing out and nothing stuck: no line.
 */
export function leadRollup(ownerSession: string, rows: readonly Delegation[], now: number): string | undefined {
  const mine = newestPerChild(rows.filter((row) => row.ownerSession === ownerSession));
  const open = mine.filter(isOpenDelegation);
  const from = open.length ? Math.min(...open.map((row) => row.createdAt)) : Infinity;
  const wave = mine.filter(
    (row) => isOpenDelegation(row) || (row.settledAt ?? 0) >= from || stuckOf(row, now)?.kind === "failed",
  );
  if (!open.length && !wave.length) return undefined;
  return batchRollup(wave.sort((a, b) => a.createdAt - b.createdAt).map(rollupState));
}

/** One row as the rail reads it: how it is stuck, else its state word. */
export function delegationLine(row: Delegation, now: number): string {
  const stuck = stuckOf(row, now);
  if (stuck?.kind === "stalled") return stuck.line;
  if (stuck?.kind === "failed") return stuck.line;
  if (stuck?.kind === "asking") return "asking its Lead";
  return { running: "working", question: "asking its Lead", completed: "done", failed: "failed", cancelled: "stopped" }[row.state];
}

/**
 * The most urgent stuck worker under one of Ash OS's jobs (`sourceRef`: `delegation:<top row>` or `ask:<ask id>`), so a
 * job reads Stuck while any worker under it is, whatever its siblings are doing.
 */
export function stuckForJob(sourceRef: string | undefined, rows: readonly Delegation[], now: number): StuckWorker | undefined {
  if (!sourceRef) return undefined;
  const byId = new Map(rows.map((row) => [row.id, row]));
  let roots: Set<string>;
  if (sourceRef.startsWith("delegation:")) roots = new Set([sourceRef.slice("delegation:".length)]);
  else if (sourceRef.startsWith("ask:")) {
    const ask = sourceRef.slice("ask:".length);
    roots = new Set(rows.filter((row) => row.askIds.includes(ask)).map((row) => row.id));
  } else return undefined;
  if (!roots.size) return undefined;
  const under = (row: Delegation) => {
    const seen = new Set<string>();
    for (let at: Delegation | undefined = row; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
      if (roots.has(at.id) || roots.has(at.rootId)) return true;
      seen.add(at.id);
    }
    return false;
  };
  return stuckWorkers(rows.filter(under), now).sort((a, b) => URGENCY[a.kind] - URGENCY[b.kind] || a.since - b.since)[0];
}
