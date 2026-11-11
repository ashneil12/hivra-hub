// Hivra WP-11: the one classifier (docs/hivra/SPEC.md section 4, step 5; firstmate's fm-classify-lib.sh and
// fm-watch.sh, MIT, Copyright (c) 2026 Kun Chen; Raven's once-per-stretch stall notice; PandaCode's silence watchdog,
// ideas only).
//
// WP-102: the sleep rule (`SLEEP_TICKS`, `sleepGap`) is translated from OpenMausBot's server/turn-watchdog.ts at
// e39d9b0d7 and da0309f6c, Apache-2.0, Copyright 2026 Milind Soni and OpenMausBot contributors. Changed: the gap is
// measured by the caller's look interval, and one interval of it is kept as the tick's own; the rule is a small pure
// function here so the headless watcher and the half-minute look share it.
//
// Plain code watches every crew and wakes a first mate only when something needs its judgment. Everything else updates
// records and the UI, never the model. It is headless (no React, DOM or Tauri; watcher.headless.test.ts walks its
// imports), so WP-60 can run it on a remote host, and it never calls a model, starts a CLI or spends a token.
//
// Inputs (`WatchEvent`): a delegation row that changed, a look at a running worker (its transcript and presence, the
// stall watcher's half-minute look), a PR or CI event from pr_watch, and a timer the first mate set.
// Outputs (`Decision`): a wake (with the road it takes), a stall to record on the row, a silent worker to stop, or
// nothing for the model.
//
// Wakes take the road they already had, so how reports reach owners doesn't change (WP-11 "Don't"):
// - `report`: a worker done or failed: its report, through delegations.rs's delivery;
// - `question`: a worker asking its first mate: the question wake (delegationQuestions.ts);
// - `pr-watch`: CI red, all green, a review or comment, a conflict, a merge or close (pr_watch/);
// - `provider-note`: a worker stuck on a provider error: self-repair's note, with a retry offered (workerStall.ts);
// - `queue`: everything else: the first mate's durable wake queue (src-tauri/src/watcher/queue.rs).
import { judgeStall, PROVIDER_STALL_PREFIX, STALL_DEFAULTS, type Presence, type Stall, type StallKind, type StallOptions, type WorkerLook } from "./stall";

const MIN = 60_000;

/** A worker with no events this long, and nothing pending, is stopped and marked failed (retryable). */
export const SILENCE_MS = 20 * MIN;

/**
 * How many ordinary look intervals a gap between two looks may last before it is read as the computer having slept
 * (OpenMausBot `e39d9b0d7`, Apache-2.0). A sleeping Mac suspends the app while its wall clock runs on, so the first look
 * after wake is late by the sleep, and that time was nobody's silence.
 */
export const SLEEP_TICKS = 3;

/**
 * The time to forgive a look that arrived late: everything over one interval, but only when the gap beats
 * `SLEEP_TICKS` intervals. An ordinary late tick is no sleep (`0`). The one interval kept is the tick's own, so a stall
 * is still caught up to one tick late and never early (OpenMausBot `da0309f6c`).
 */
export function sleepGap(gapMs: number, everyMs: number): number {
  if (!(everyMs > 0) || gapMs <= SLEEP_TICKS * everyMs) return 0;
  return gapMs - everyMs;
}
/** The failure a silence stop records: no word the self-repair retries on ("timed out", "killed"), so its first mate decides. */
export const SILENCE_ERROR_CLASS = "silent";

/** What the classifier reads of a delegation row (monos/model/delegations.ts `Delegation` fits it). */
export type RowFacts = {
  id: string;
  ownerSession: string;
  childSession: string;
  generation: number;
  state: string;
  title?: string | null;
  follow?: string | null;
  stallKind?: StallKind | null;
  stallReason?: string | null;
  stalledAt?: number | null;
  pendingQuestion?: string | null;
  questionOwner?: string | null;
  gateVerdict?: string | null;
  /** The status Rust derived (firstmate/status.rs); the classifier trusts it over its own reading of `state`. */
  status?: string;
  error?: string | null;
  log?: readonly Record<string, unknown>[];
};

export type PrEventKind = "ci-red" | "ci-green" | "comment" | "conflict" | "merged" | "closed";

export type WatchEvent =
  | { kind: "row"; before?: RowFacts | null; row: RowFacts }
  | {
      kind: "look";
      row: RowFacts;
      look: WorkerLook;
      presence: Presence;
      /** The worker's chat waits on its own open delegations: its workers are judged, not it. */
      waitsOnWorkers: boolean;
      /** The hourly progress judge's verdict while it holds one (selfRepair.ts). */
      hourly?: Stall | null;
      options?: StallOptions;
    }
  | { kind: "pr"; ownerSession: string; event: PrEventKind; title?: string }
  | { kind: "timer"; ownerSession: string; timerId: string; note: string };

export type WakeKind =
  | "worker-done"
  | "worker-failed"
  | "worker-blocked"
  | "worker-asking"
  | "stall"
  | "silence"
  | "pr"
  | "timer";

export type WakeRoute = "report" | "question" | "pr-watch" | "provider-note" | "queue";

export type Wake = {
  kind: WakeKind;
  route: WakeRoute;
  ownerSession: string;
  /** Said once per owner and key, ever (the queue's dedupe). */
  key: string;
  delegationId?: string;
  generation?: number;
  title?: string;
  /** The first mate's line, in plain words. */
  text: string;
  /** The stall a stall notice is about. */
  stall?: Stall;
};

export type Decision =
  | { kind: "wake"; wake: Wake }
  /** Record a judged stall on the row (none clears it). Records and the UI only. */
  | { kind: "stall"; row: RowFacts; stall: Stall | null }
  /** The silence watchdog: stop this worker's turn and settle its row failed, retryable. Its report is the wake. */
  | { kind: "stop"; row: RowFacts; error: string; errorClass: string; since: number }
  /** Nothing for the model: the change shows in records and the UI only. */
  | { kind: "record"; reason: string };

const titleOf = (row: Pick<RowFacts, "title">) => row.title?.trim().split("\n")[0].slice(0, 80) || "its job";
const minutes = (ms: number) => Math.max(1, Math.round(ms / MIN));
const isOpen = (state: string) => state === "running" || state === "question";

/** Who declared a row's `blocked` stall: the worker on its own work (`self:`) or its first mate (firstmate/status.rs). */
export function blockedBySelf(row: Pick<RowFacts, "log">): boolean {
  const entry = [...(row.log ?? [])].reverse().find((e) => e.event === "stalled" && e.kind === "blocked");
  return typeof entry?.by === "string" && entry.by.startsWith("self:");
}

function record(reason: string): Decision {
  return { kind: "record", reason };
}

function wake(w: Wake): Decision {
  return { kind: "wake", wake: w };
}

/** A row changed: done, failed, asking or blocked need its first mate; anything else is records only. */
export function classifyRow(before: RowFacts | null | undefined, row: RowFacts): Decision[] {
  const base = { ownerSession: row.ownerSession, delegationId: row.id, generation: row.generation, title: titleOf(row) };
  const sameTurn = before && before.generation === row.generation;
  const settled = !isOpen(row.state);
  if (settled) {
    if (sameTurn && before.state === row.state && before.gateVerdict === row.gateVerdict) return [record("no change")];
    const status = row.status;
    if (row.state === "cancelled") return [record("stopped by someone who already knows")];
    if (status === "working") return [record("finished; its checks are still running")];
    if (status === "paused") return [record("Waiting for a usage limit to reset")];
    if (row.state === "completed" && (status === undefined || status === "done"))
      return [wake({ ...base, kind: "worker-done", route: "report", key: `report:${row.id}:${row.generation}`, text: `"${titleOf(row)}" is done.` })];
    return [
      wake({
        ...base,
        kind: "worker-failed",
        route: "report",
        key: `report:${row.id}:${row.generation}`,
        text: `"${titleOf(row)}" failed${row.error ? `: ${row.error}` : "."}`,
      }),
    ];
  }
  const out: Decision[] = [];
  if (row.state === "question" && row.questionOwner !== "person" && !(sameTurn && before.state === "question" && before.pendingQuestion === row.pendingQuestion))
    out.push(
      wake({
        ...base,
        kind: "worker-asking",
        route: "question",
        key: `question:${row.id}:${row.generation}:${row.pendingQuestion ?? ""}`,
        text: `"${titleOf(row)}" asks: ${row.pendingQuestion ?? "a question"}`,
      }),
    );
  const newlyBlocked = row.stallKind === "blocked" && !(sameTurn && before.stallKind === "blocked");
  if (newlyBlocked && blockedBySelf(row))
    out.push(
      wake({
        ...base,
        kind: "worker-blocked",
        route: "queue",
        key: `blocked:${row.id}:${row.generation}`,
        text: `Your worker on "${titleOf(row)}" says it can't finish${row.stallReason ? `: ${row.stallReason}` : "."} Decide: unblock it (task_answer or a message), retry it differently (delegate_task with redoes "${row.id}"), or stop it (task_cancel ${row.id}).`,
      }),
    );
  return out.length ? out : [record("still working")];
}

/** The stall a look judges: the worker's own (quiet, idle, loop) or the hourly judge's, as the stall watcher always chose. */
function stallOf(event: Extract<WatchEvent, { kind: "look" }>, now: number): Stall | null {
  if (event.waitsOnWorkers) return null;
  const own = judgeStall(event.look, event.presence, now, event.options ?? STALL_DEFAULTS);
  const hourly = event.hourly ?? null;
  // Silence now (quiet, idle) says more than the hour's verdict; otherwise the hour's verdict stands while it holds.
  return hourly?.final ? hourly : own && own.kind !== "loop" ? own : (hourly ?? own);
}

/**
 * The start of the worker's current silent stretch: when it last did anything the watcher saw. A quiet or idle stall
 * stored on the row (before a restart, say) with nothing seen since keeps its own start, so the records, not this
 * window's memory, say how long it has been silent: a restart neither repeats a notice nor resets the 20 minutes.
 */
export function stretchStart(presence: Presence, row?: Pick<RowFacts, "stallKind" | "stalledAt">): number {
  const seen = presence.lastChangeAt ?? presence.watchedSince;
  const stored = row && (row.stallKind === "quiet" || row.stallKind === "idle") ? row.stalledAt : null;
  if (stored != null && (presence.lastChangeAt ?? 0) <= stored) return Math.min(stored, seen);
  return seen;
}

/**
 * Whether this worker has been silent long enough to stop: no events for `SILENCE_MS`, its row running, nothing
 * holding it (a question or approval never counts as silence, nor a queued message or a usage limit), and it is a
 * worker, not a first mate's own chat (one waiting on its workers, or a followed Lead's long-running chat).
 */
export function silentFor(event: Extract<WatchEvent, { kind: "look" }>, now: number, silenceMs = SILENCE_MS): number | null {
  const { row, look } = event;
  if (row.state !== "running" || row.stallKind === "blocked" || row.follow === "lead") return null;
  if (event.waitsOnWorkers || look.asking || look.queued || look.limited) return null;
  const quiet = now - stretchStart(event.presence, row);
  return quiet >= silenceMs ? quiet : null;
}

/**
 * A look at a running worker: record its stall, tell its first mate once per silent stretch, and stop it at 20 minutes.
 * `sleptMs` is the time the computer slept before this look (classifier.ts `sleepGap`): it is forgiven, not silence, and
 * the look judges nothing that one time.
 */
export function classifyLook(
  event: Extract<WatchEvent, { kind: "look" }>,
  now: number,
  silenceMs = SILENCE_MS,
  slept?: { sleptMs: number },
): Decision[] {
  const { row } = event;
  // A declared block (task_cannot) is the agent's own word, not a judgment: it stands until the row itself moves.
  if (row.state !== "running" || row.stallKind === "blocked") return [record("not judged")];
  if (slept && slept.sleptMs > 0) return [record("the computer slept; the clock moved forward")];
  const quiet = silentFor(event, now, silenceMs);
  if (quiet !== null) {
    const since = stretchStart(event.presence, row);
    return [
      {
        kind: "stop",
        row,
        since,
        errorClass: SILENCE_ERROR_CLASS,
        error: `Silent for ${minutes(quiet)} minutes with no question or approval pending; the watcher stopped its turn. It can be retried.`,
      },
    ];
  }
  const stall = stallOf(event, now);
  const stored = row.stallKind ?? null;
  const out: Decision[] = [];
  if (stall && (stall.kind !== stored || stall.reason !== (row.stallReason ?? ""))) out.push({ kind: "stall", row, stall });
  if (!stall && stored && (event.waitsOnWorkers || (event.presence.lastChangeAt ?? 0) > (row.stalledAt ?? 0)))
    out.push({ kind: "stall", row, stall: null });
  // A stall stored before a restart, with nothing seen since, still stands for the notice (said once by its key).
  const storedStill =
    !stall && (stored === "quiet" || stored === "idle") && row.stalledAt != null && (event.presence.lastChangeAt ?? 0) <= row.stalledAt
      ? { kind: stored, reason: row.stallReason ?? "", since: row.stalledAt }
      : null;
  const notice = stall ?? storedStill;
  if (notice && (notice.kind === "quiet" || notice.kind === "idle")) {
    const stall = notice;
    // One notice per silent stretch: the key is the stretch's start, so only new activity re-arms it.
    const since = stretchStart(event.presence, row);
    const provider = stall.reason.startsWith(PROVIDER_STALL_PREFIX);
    out.push(
      wake({
        kind: "stall",
        route: provider ? "provider-note" : "queue",
        ownerSession: row.ownerSession,
        delegationId: row.id,
        generation: row.generation,
        title: titleOf(row),
        stall,
        key: provider ? `provider:${row.id}:${row.generation}:${stall.since}` : `stall:${row.id}:${row.generation}:${since}`,
        text:
          stall.kind === "idle"
            ? `Your worker on "${titleOf(row)}" stopped ${minutes(now - since)} minutes ago without reporting back. Look at it (task_status ${row.id}); continue, retry or stop it. If it stays silent, the app stops it at ${minutes(silenceMs)} minutes.`
            : `Your worker on "${titleOf(row)}" has been quiet for ${minutes(now - since)} minutes${stall.reason ? ` (${stall.reason})` : ""}. Look at it (task_status ${row.id}) if you want to steer, retry or stop it. If it stays silent, the app stops it at ${minutes(silenceMs)} minutes.`,
      }),
    );
  }
  return out.length ? out : [record(stall ? "stall unchanged" : "moving")];
}

/** A PR event: pr_watch already wakes the owner for each of these, and each is a judgment (fix, merge, answer, record). */
export function classifyPr(event: Extract<WatchEvent, { kind: "pr" }>): Decision[] {
  return [
    wake({
      kind: "pr",
      route: "pr-watch",
      ownerSession: event.ownerSession,
      key: `pr:${event.event}`,
      title: event.title,
      text: event.title ? `${event.title}: ${event.event}` : event.event,
    }),
  ];
}

export function classifyTimer(event: Extract<WatchEvent, { kind: "timer" }>): Decision[] {
  return [
    wake({ kind: "timer", route: "queue", ownerSession: event.ownerSession, key: `timer:${event.timerId}`, title: "Timer", text: `Your timer: ${event.note}` }),
  ];
}

/** The one entry point: an event and the time, to what code does about it. Pure. */
export function classify(
  event: WatchEvent,
  now: number,
  silenceMs = SILENCE_MS,
  slept?: { sleptMs: number },
): Decision[] {
  switch (event.kind) {
    case "row":
      return classifyRow(event.before, event.row);
    case "look":
      return classifyLook(event, now, silenceMs, slept);
    case "pr":
      return classifyPr(event);
    case "timer":
      return classifyTimer(event);
  }
}

/** The wakes in a list of decisions that go through the first mate's own queue (the rest have their own roads). */
export function queuedWakes(decisions: readonly Decision[]): Wake[] {
  return decisions.flatMap((d) => (d.kind === "wake" && d.wake.route === "queue" ? [d.wake] : []));
}
