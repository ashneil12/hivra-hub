// Stall detection for delegated workers (H4, Ash 20 Oct: "easy to see when a subagent is stuck"). A worker can be stuck
// without asking or failing: it goes quiet mid-turn, loops on the same step, or stops without reporting back. The
// watcher here judges every running delegation row whose child chat this window runs, and writes what it finds onto the
// row (delegations.rs `set_stall`), so every surface reads one fact: the Lead's chat, the Monos rail, Being built,
// Today, the Lead's own task tools and Ash OS's copy.
//
// Two facts are kept apart (Block's Buzz: presence vs lifecycle):
// - presence, "is it talking": the last change to its transcript this window saw;
// - lifecycle, "is the turn alive": the chat is busy (a turn runs), or idle while its row still says running.
// What this window hasn't seen is unknown, and unknown is never stuck: the clock starts the first time a worker is seen
// (after a restart too), and a stall stored before a restart stays until real activity is seen.
//
// Stuck, by kind:
// - quiet: busy, but no change for `quietMs` (6 min), or `longToolMs` (20 min) while a tool it started still runs;
// - loop: the same finished step (same call, same output) `loopRepeats` (6) times in a row at the end of its turn, or the
//   hourly progress check (workerProgress.ts, Ash's 14 Oct rule) found no real progress in its hour: commits, changed
//   files, passing tests and messages, read from its folder and transcript, not just new steps;
// - idle: not busy, nothing holding it (a question, a queued message, a limit it waits out), its row still running, for
//   `idleMs`: it stopped without reporting back.
// A chat that waits on its own workers is never stalled: its workers are judged instead.
import { appIdentity } from "../../../app/model/appIdentity";
import type { Block } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation, type DelegationTracker } from "./delegations";
import { serviceStallLine } from "./workerStuck";
import { classifyLook, SILENCE_MS, type Decision, type Wake } from "../../firstmate/watcher/classifier";

// WP-102: the sleep rule lives in the classifier beside SILENCE_MS; re-exported so the tick host can name its constant.
export { sleepGap, SLEEP_TICKS } from "../../firstmate/watcher/classifier";

// Moved to the watcher (Hivra WP-11, firstmate/watcher/stall.ts); re-exported so callers keep their imports.
import { lookAt } from "../../firstmate/watcher/look";
import {
  MIN,
  PROVIDER_STALL_PREFIX,
  STALL_DEFAULTS,
  type Presence,
  type Stall,
  type StallOptions,
  type WorkerChat,
  type WorkerLook,
} from "../../firstmate/watcher/stall";
export { lookAt } from "../../firstmate/watcher/look";
export {
  judgeStall,
  providerErrorAtEnd,
  PROVIDER_STALL_PREFIX,
  STALL_DEFAULTS,
  type Presence,
  type Stall,
  type StallOptions,
  type WorkerLook,
} from "../../firstmate/watcher/stall";

/** Minutes of silence before a busy worker counts as stuck (Settings key; the long-tool wait is at least 3x it). */
export const STALL_MINUTES_KEY = "monocode:stall-minutes";

export function stallOptions(): StallOptions {
  // The fake-Claude bench (hub:verify-live) asks for seconds: only a dev copy under a temporary HOME has a plan.
  const bench = appIdentity()?.kind === "dev" ? appIdentity()?.verify?.stallMs : undefined;
  if (bench) return { ...STALL_DEFAULTS, quietMs: bench, idleMs: bench, longToolMs: 3 * bench };
  let minutes: number | undefined;
  try {
    const raw = Number(localStorage.getItem(STALL_MINUTES_KEY));
    if (Number.isFinite(raw) && raw >= 1 && raw <= 240) minutes = raw;
  } catch {
    /* defaults */
  }
  if (!minutes) return STALL_DEFAULTS;
  return {
    ...STALL_DEFAULTS,
    quietMs: minutes * MIN,
    idleMs: minutes * MIN,
    longToolMs: Math.max(STALL_DEFAULTS.longToolMs, 3 * minutes * MIN),
  };
}

/**
 * r87: the Lead's line for a worker stuck after a provider error: what happened, that it is flagged on Today and Being
 * built, and the retry it can make. Never Ash's words.
 */
export function providerStallNote(row: Pick<Delegation, "id" | "title">, stall: Stall): string {
  const title = row.title?.trim().split("\n")[0].slice(0, 80) || "its job";
  return `Your worker on "${title}" hit a provider error and has made no progress since (${stall.reason.replace(`${PROVIDER_STALL_PREFIX}, `, "")}). It shows as stuck on the rail. It may recover by itself; if it doesn't, retry it with delegate_task redoes "${row.id}" and the same brief. Tell Ash in one line that it stalled on a provider error and what you're doing about it.`;
}

/**
 * r88 (s15 scripted run 2: Today and Being built said it at once, the Lead's own words came ~20s later): the line the
 * Lead's chat shows from the app the moment the flag is set, before the Lead has said anything. Once per stall.
 */
export function providerStallChatLine(row: Pick<Delegation, "id" | "title">, stall: Stall): Block {
  const title = row.title?.trim().split("\n")[0].slice(0, 80) || "its job";
  const why = stall.reason.replace(`${PROVIDER_STALL_PREFIX}, `, "");
  return {
    id: `provider-stall-${row.id}-${stall.since}`,
    role: "system",
    // r91 (Critiquito): Ash's words, no codes ("API retry 2 of 2 · API overloaded (529)" stays in the Lead's note).
    text: `The worker on "${title}" has stalled. ${serviceStallLine(why).replace(/^Stalled: t/, "T")} It shows as stalled on the rail; its Lead can try it again, or you can open its chat from the rail.`,
    startedAt: stall.since,
  } as Block;
}

/** What the watcher needs from the app. */
export type StallWatchHost = {
  tracker(): DelegationTracker | null;
  /** A chat as this window has it (only a chat this window runs is judged). */
  session(id: string): WorkerChat | undefined;
  /** How many open rows a chat owns (a chat waiting on its own workers isn't stalled). */
  openOwned(chat: string): number;
  now?(): number;
  options?(): StallOptions;
  /** The hourly progress check's verdict on a row, while it holds one (selfRepair.ts). */
  hourly?(row: Delegation): Stall | null;
  /** r87: a worker stuck after a provider error, once per error: its Lead is told and offered a retry. */
  providerStall?(row: Delegation, stall: Stall): void;
  /** Hivra WP-11: a wake for the worker's first mate's durable queue (a stall notice, once per silent stretch). */
  wake?(wake: Wake): void;
  /** Hivra WP-11: the silence watchdog stops this worker (stop its turn, settle it failed and retryable). Once per row. */
  silent?(row: Delegation, stop: Extract<Decision, { kind: "stop" }>): void;
  /** How long silence lasts before the stop (tests; 20 minutes otherwise). */
  silenceMs?(): number;
};

type Seen = Presence & { fingerprint: readonly unknown[] };

/**
 * One per main window: `sync` on every change to the chats (it notes what moved, and clears a stall the moment its
 * worker moves again), `tick` every half minute (it raises the stalls). Each change reaches the row once.
 */
export class StallWatch {
  private seen = new Map<string, Seen>();
  private writing = new Set<string>();
  private toldProvider = new Map<string, number>();
  /** Queue wakes already handed over this run (the queue itself says each key once, across restarts too). */
  private woke = new Set<string>();
  /** Rows the silence watchdog already stopped. */
  private stopped = new Set<string>();

  constructor(private host: StallWatchHost) {}

  private now() {
    return (this.host.now ?? Date.now)();
  }

  /** The rows judged: running, owned by someone, their chat in this window. */
  private running(): Delegation[] {
    const tracker = this.host.tracker();
    if (!tracker?.isLoaded()) return [];
    return tracker.known().filter((row) => row.state === "running" && isOpenDelegation(row));
  }

  /** Note whether a watched worker moved since the last look (cheap: it runs on every streamed word). */
  private presence(row: Delegation, chat: WorkerChat, now: number): Seen {
    const fingerprint = [chat.blocks, !!chat.busy, chat.queuedMessages?.length ?? 0, chat.pendingQuestion ?? null, chat.queueStatus];
    const known = this.seen.get(row.childSession);
    if (!known) {
      const fresh: Seen = { watchedSince: now, lastProgressAt: now, steps: -1, fingerprint };
      this.seen.set(row.childSession, fresh);
      return fresh;
    }
    if (fingerprint.some((part, i) => part !== known.fingerprint[i])) {
      known.fingerprint = fingerprint;
      known.lastChangeAt = now;
    }
    return known;
  }

  /** Read the transcript (the half-minute look): new steps are progress, and when a run of repeats began. */
  private progress(seen: Seen, look: WorkerLook, now: number) {
    if (seen.steps >= 0 && look.steps > seen.steps) seen.lastProgressAt = now;
    seen.steps = look.steps;
    if (!look.repeat) delete seen.repeatSince;
    else seen.repeatSince ??= now;
  }

  private judge(row: Delegation, mode: "clear" | "both", sleptMs = 0) {
    const chat = this.host.session(row.childSession);
    if (!chat) return; // Not this window's: unknown, never stuck.
    const now = this.now();
    const seen = this.presence(row, chat, now);
    // WP-102: time the computer slept is not silence. Every running worker's clock is moved forward by the gap, so its
    // silent stretch starts at the wake; the look itself judges nothing (classifier.ts `classifyLook` receives `sleptMs`).
    if (sleptMs > 0) {
      seen.lastChangeAt = Math.min(now, (seen.lastChangeAt ?? now) + sleptMs);
      seen.lastProgressAt = Math.min(now, (seen.lastProgressAt ?? now) + sleptMs);
      if (seen.errorSince != null) seen.errorSince = Math.min(now, seen.errorSince + sleptMs);
      if (seen.repeatSince != null) seen.repeatSince = Math.min(now, seen.repeatSince + sleptMs);
    }
    const stored = row.stallKind ?? null;
    // A declared block (task_cannot) is the agent's own word, not a judgment: the watcher never overwrites or clears it.
    // It stands until the row itself moves (a settle, a Stop, a retried generation), which clears the stall in Rust.
    if (stored === "blocked") return;
    const moved = (seen.lastChangeAt ?? 0) > (row.stalledAt ?? 0);
    // Between looks only a stalled worker that moved is judged (to clear it at once); the rest wait for the look.
    if (mode === "clear" && !(stored && moved)) return;
    const look = lookAt(chat);
    if (look.providerError) seen.errorSince ??= now;
    else delete seen.errorSince;
    if (mode === "both") this.progress(seen, look, now);
    const waitsOnWorkers = this.host.openOwned(row.childSession) > 0;
    // Hivra WP-11: the classifier decides (firstmate/watcher/classifier.ts); this window carries it out.
    const decisions = classifyLook(
      {
        kind: "look",
        row,
        look,
        presence: seen,
        waitsOnWorkers,
        hourly: waitsOnWorkers ? null : (this.host.hourly?.(row) ?? null),
        options: this.host.options?.() ?? stallOptions(),
      },
      now,
      this.host.silenceMs?.() ?? SILENCE_MS,
      { sleptMs },
    );
    for (const decision of decisions) {
      if (decision.kind === "stall") {
        // A stall is raised on the look; a clear lands at once, on any change.
        if (decision.stall && mode !== "both") continue;
        this.write(row, decision.stall);
      } else if (decision.kind === "stop") {
        if (mode !== "both") continue;
        const key = `${row.id}:${row.generation}`;
        if (this.stopped.has(key)) continue;
        this.stopped.add(key);
        this.host.silent?.(row, decision);
      } else if (decision.kind === "wake" && mode === "both") {
        const { wake } = decision;
        if (wake.route === "provider-note" && wake.stall) {
          // r87 (s14 r86 run 3: a worker sat three minutes on "API Error: Server error" and nobody heard): told once.
          if (this.toldProvider.get(row.id) === wake.stall.since) continue;
          this.toldProvider.set(row.id, wake.stall.since);
          this.host.providerStall?.(row, wake.stall);
        } else if (wake.route === "queue" && !this.woke.has(wake.key)) {
          this.woke.add(wake.key);
          this.host.wake?.(wake);
        }
      }
    }
  }

  private write(row: Delegation, stall: Stall | null) {
    const tracker = this.host.tracker();
    if (!tracker || this.writing.has(row.id)) return;
    this.writing.add(row.id);
    void tracker
      .setStall(row, stall)
      .catch((error: unknown) => console.error("Could not record the worker's stall", error))
      .finally(() => this.writing.delete(row.id));
  }

  /** The chats changed: note who moved, and clear a stall whose worker moved again. */
  sync(): void {
    for (const row of this.running()) this.judge(row, "clear");
  }

  /**
   * The half-minute look: raise and clear. `sleptMs` is the time the computer slept before it (WP-102, `sleepGap`): every
   * running worker's clock moves forward by that much, and the look stops nobody.
   */
  tick(sleptMs = 0): void {
    const rows = this.running();
    const live = new Set(rows.map((row) => row.childSession));
    for (const child of this.seen.keys()) if (!live.has(child)) this.seen.delete(child);
    for (const row of rows) this.judge(row, "both", sleptMs);
  }
}
