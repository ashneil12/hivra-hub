// Which delegated workers are stuck, and how (H4; Ash 20 Oct: "easy to see when a subagent is stuck both from the main
// agent and from other parts of the UI, being able to respond quickly or go into the chat"). One reading of the
// delegation rows for every surface: the Lead's chat (a card per stuck worker), the Monos rail (a mark on the Mono, a
// split "2 working · 1 stuck"), Being built (a job with a stuck worker under it reads Stuck, whatever its siblings do),
// Today, and the native notification.
//
// Stuck is one of:
// - asking: the worker asked its Lead (state `question`). It stays the Lead's (D5, Ash 21 Oct 20:40/20:42): the Lead
//   answers it when Ash's words cover it, otherwise asks Ash in the Lead's own chat and relays his answer with
//   task_answer (delegationQuestions.ts). It is never escalated past the Lead, so Ash never has to open the worker.
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

/**
 * How long a worker's question had waited on its Lead before it used to become Ash's too. Since D5 (Ash, 21 Oct) a
 * worker's question never leaves the Lead's chat; kept so "not answered yet" can still read on the Lead's own card.
 */
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

/** A failure the app retries by itself: its process died, or the provider failed for a moment (not a refusal or limit). */
export function isCrash(row: Pick<Delegation, "state" | "errorClass">): boolean {
  if (row.state !== "failed") return false;
  return !isProviderErrorClass(row.errorClass) || row.errorClass === "overloaded" || row.errorClass === "provider_error";
}

/** How many times this row's work ended failed (its log keeps the newest fifty moves). */
export function failedTimes(row: Pick<Delegation, "log">): number {
  return (row.log ?? []).filter((entry) => entry.event === "settled" && entry.state === "failed").length;
}

/** Self-repair's tries (workerProgress.ts): more failures than this means its retries ran out. */
const REPAIR_TRIES = 3;

/**
 * "Failed: usage limit reached, resets 3:10pm", "Failed: billing refused", "Failed: the build broke"; a crash that came
 * back says so: "Crashed 4 times, retries ran out: Claude exited with code 1".
 */
export function failureLine(row: Pick<Delegation, "errorClass" | "error" | "resetsAt"> & Partial<Pick<Delegation, "state" | "log">>): string {
  const times = row.log ? failedTimes({ log: row.log }) : 0;
  if (times >= 2 && isCrash({ state: row.state ?? "failed", errorClass: row.errorClass })) {
    const what = row.errorClass === "overloaded" ? "Provider overloaded" : row.errorClass === "provider_error" ? "Provider failed" : "Crashed";
    const first = (row.error ?? "").trim().split("\n")[0].replace(/[.!?\s]+$/, "");
    const words = what === "Crashed" && first ? `: ${first.length > 120 ? `${first.slice(0, 120).replace(/\s+\S*$/, "")}…` : first}` : "";
    return `${what} ${times} times${times > REPAIR_TRIES ? ", retries ran out" : ""}${words}`;
  }
  if (isProviderErrorClass(row.errorClass)) {
    const reset = row.errorClass === "usage_limit" && row.resetsAt ? clock(row.resetsAt) : "";
    return `Failed: ${PROVIDER_ERROR_LABEL[row.errorClass]}${reset ? `, resets ${reset}` : ""}`;
  }
  const first = (row.error ?? "").trim().split(/(?<=[.!?])\s/)[0]?.replace(/[.!?\s]+$/, "") ?? "";
  const words = first.length > 140 ? `${first.slice(0, 140).replace(/\s+\S*$/, "")}…` : first;
  return `Failed: ${words ? lowerFirst(words) : "it stopped without saying why"}`;
}

// Commands a stall reason names, in Ash's words (Critiquito, 21 Oct: "still running npm test" is jargon).
const PLAIN_COMMANDS: [RegExp, string][] = [
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?\b|\b(?:npx\s+)?(?:vitest|jest|playwright test|pytest)\b(?:\s+run)?|\bcargo\s+test\b|\bgo\s+test\b/gi, "the tests"],
  [/\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b|\bcargo\s+build\b|\b(?:npx\s+)?tsc\b(?:\s+--noEmit)?|\b(?:npx\s+)?vite\s+build\b/gi, "the build"],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add)\b|\bpip\s+install\b/gi, "an install"],
  [/\b(?:npm|pnpm|yarn|bun)\s+run\s+lint\b|\b(?:npx\s+)?eslint\b|\bcargo\s+clippy\b/gi, "the code checks"],
  [/\bgit\s+push\b/gi, "a push"],
];

/** A worker's stall reason with the commands it names said plainly ("Still running npm test" → "Still running the tests"). */
export function plainReason(reason: string): string {
  let out = reason;
  for (const [pattern, words] of PLAIN_COMMANDS) out = out.replace(pattern, words);
  return out.replace(/\b(the tests|the build|an install|the code checks|a push)(?:\s+\1)+/g, "$1");
}

/** How a stalled worker is stuck, with how long ("No output for 9 min · still running the tests"). */
export function stallLine(row: Pick<Delegation, "stallKind" | "stallReason" | "stalledAt">, now: number): string {
  const since = row.stalledAt ?? now;
  const reason = plainReason(row.stallReason?.trim() ?? "");
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

const RECOMMENDED = /\s*[([]\s*recommended\s*[)\]]\s*/i;

/**
 * A worker's question as its row stores it ("How long? [0.25 s (Recommended) | 0.4 s]"): the words to show, without the
 * "(Recommended)" marker, and the option it recommends (one question only).
 */
export function storedQuestion(summary: string | null | undefined): { text: string; pick?: string } {
  const raw = summary?.trim() ?? "";
  const options = /\[([^[\]]+)\]\s*$/.exec(raw);
  const single = !raw.includes(" / ");
  const pick = single && options ? options[1].split(" | ").find((option) => RECOMMENDED.test(option)) : undefined;
  return {
    text: raw.replace(RECOMMENDED, " ").replace(/\s+\]/g, "]").replace(/\s+\|/g, " |").replace(/\s{2,}/g, " ").trim(),
    ...(pick ? { pick: pick.replace(RECOMMENDED, " ").trim() } : {}),
  };
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
    line = storedQuestion(row.pendingQuestion).text || "Asked its Lead a question";
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
    // A worker's question is the Lead's to ask Ash in its own chat (D5), never Ash's directly.
    escalated: kind !== "asking",
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

/**
 * "2 working · 1 waiting · 1 stuck", or nothing when nothing is out. One word for a worker that asked its Lead a
 * question everywhere (Ash, 22 Oct): it is waiting on its Lead, never "asking", "stuck" or "Need approval".
 */
export function workSplit(counts: WorkCounts): string | undefined {
  const parts = [
    counts.working ? `${counts.working} working` : "",
    counts.asking ? `${counts.asking} waiting` : "",
    counts.stuck ? `${counts.stuck} stuck` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * The short form, where room is tight (a Mono's line on the rail, a brief's line in its chat): what still works, what
 * waits on its Lead, and what is stuck ("2 working · 1 waiting · 1 stuck", Ash's words, 20 Oct). A worker that asked its
 * Lead a question is waiting, not stuck (Ash, 22 Oct): the Lead answers it or asks Ash in its own chat (D5).
 */
export function shortSplit(counts: WorkCounts): { working: number; waiting: number; stuck: number; text?: string } {
  const text = [
    counts.working ? `${counts.working} working` : "",
    counts.asking ? `${counts.asking} waiting` : "",
    counts.stuck ? `${counts.stuck} stuck` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { working: counts.working, waiting: counts.asking, stuck: counts.stuck, ...(text ? { text } : {}) };
}

/**
 * A worker's status where its Lead's launches are listed (a Mono's Sessions tab): one that asked a question waits on
 * that Lead ("Waiting on Alfred"), not on Ash's approval. A tool approval it is waiting for is still Ash's to give.
 */
export function waitingOnLeadLabel(
  live: { pendingQuestion?: unknown; approvalPending: boolean } | undefined,
  leadName: string,
): string | undefined {
  if (!live || !live.pendingQuestion || live.approvalPending) return undefined;
  return `Waiting on ${leadName.trim() || "its Lead"}`;
}

/**
 * A delegated worker whose only open thing is a question: it waits on its Lead (D5), so it is not Ash's input. Lists
 * that mark chats "Need approval" / "Needs input" leave it (and its Lead) out; a tool approval it waits for is Ash's.
 */
export function waitsOnlyOnItsLead(
  session: { id: string; pendingQuestion?: unknown; approvalPending: boolean },
  rows: readonly Pick<Delegation, "childSession" | "createdAt" | "state">[],
): boolean {
  if (session.approvalPending || session.pendingQuestion == null) return false;
  let row: Pick<Delegation, "childSession" | "createdAt" | "state"> | undefined;
  for (const entry of rows) if (entry.childSession === session.id && (!row || entry.createdAt > row.createdAt)) row = entry;
  return !!row && (row.state === "question" || row.state === "running");
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

/**
 * How long a running worker has run, from its first hour ("6 h 20 min"): shown apart from its state, in muted text,
 * never as a status of its own (no time or cost pushes to Ash).
 */
export function runningFor(row: Pick<Delegation, "state" | "createdAt">, now: number): string | undefined {
  if (row.state !== "running" || now - row.createdAt < 60 * 60_000) return undefined;
  return minutes(now - row.createdAt);
}

/** What its Lead last did about a stuck worker: retried it, split it (into `count`), or stopped it. */
export type LeadAction = { kind: "retried" | "split" | "stopped"; count: number; at: number };

/** Redos this close together are one go: several delegations naming one stuck task in a turn split it. */
export const REDO_TOGETHER_MS = 15 * 60_000;

type LogEntry = { at?: unknown; by?: unknown; event?: unknown };
const atOf = (entry: LogEntry) => (typeof entry.at === "number" ? entry.at : 0);
const byLead = (entry: LogEntry) => typeof entry.by === "string" && entry.by.startsWith("owner:");

/**
 * Its Lead's latest action, from the row's log (kept by the store, so it is there after a restart): a `lead_redo`
 * (delegate_task `redoes`; one is a retry, several together a split) or a cancel by its owner (task_cancel).
 */
export function leadAction(row: Pick<Delegation, "log">): LeadAction | undefined {
  const log = (row.log ?? []) as LogEntry[];
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (!byLead(entry)) continue;
    if (entry.event === "cancelled") return { kind: "stopped", count: 1, at: atOf(entry) };
    if (entry.event !== "lead_redo") continue;
    // The go this redo belongs to: the redos just before it, each within REDO_TOGETHER_MS of the next.
    let count = 1;
    let first = atOf(entry);
    for (let j = i - 1; j >= 0; j--) {
      const earlier = log[j];
      if (earlier.event !== "lead_redo" || !byLead(earlier)) continue;
      if (first - atOf(earlier) > REDO_TOGETHER_MS) break;
      count++;
      first = atOf(earlier);
    }
    return { kind: count > 1 ? "split" : "retried", count, at: first };
  }
  return undefined;
}

/** "at 2h", "at 2h 10m", "at 40m": how far into the worker's run. */
function runAt(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  return min % 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${Math.floor(min / 60)}h`;
}

/** One plain line for its card: "Hivra lead retried it at 2h", "Hivra lead split it into 2 cards", "… stopped it at 3h". */
export function leadActionLine(row: Pick<Delegation, "log" | "createdAt">, leadName: string): string | undefined {
  const action = leadAction(row);
  if (!action) return undefined;
  const who = leadName.charAt(0).toUpperCase() + leadName.slice(1);
  if (action.kind === "split") return `${who} split it into ${action.count} cards`;
  return `${who} ${action.kind} it at ${runAt(action.at - row.createdAt)}`;
}

/** One row as the rail reads it: how it is stuck, else its state word. */
export function delegationLine(row: Delegation, now: number, leadName?: string): string {
  const stuck = stuckOf(row, now);
  if (stuck?.kind === "stalled") return stuck.line;
  if (stuck?.kind === "failed") return stuck.line;
  if (stuck?.kind === "asking") return `waiting on ${leadName?.trim() || "its Lead"}`;
  if (row.state === "cancelled" && leadAction(row)?.kind === "stopped") return "stopped by its Lead";
  return { running: "working", question: `waiting on ${leadName?.trim() || "its Lead"}`, completed: "done", failed: "failed", cancelled: "stopped" }[row.state];
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

/**
 * The stuck cards a Lead's chat shows. While the Lead itself is asking Ash a question in that chat, a worker's own
 * question card is left out: the Lead is asking it already (D5: the Lead asks in its own chat), and showing both put
 * the same question in front of Ash twice (live 22 Oct). Stalled and failed workers always show.
 */
export function stuckShownInLeadChat<S extends Pick<StuckWorker, "kind">>(stuck: readonly S[], leadAsking: boolean): S[] {
  return leadAsking ? stuck.filter((s) => s.kind !== "asking") : [...stuck];
}
