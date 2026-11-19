// Hivra WP-11: how the watcher reads a worker's transcript and judges a stall, moved here from
// monos/model/workerStall.ts (H4, Ash 20 Oct: "easy to see when a subagent is stuck") so the classifier owns it. Headless:
// no React, no DOM, no Tauri, no model (watcher.headless.test.ts checks the imports).
//
// Two facts are kept apart (Block's Buzz: presence vs lifecycle):
// - presence, "is it talking": the last change to its transcript the watcher saw;
// - lifecycle, "is the turn alive": the chat is busy (a turn runs), or idle while its row still says running.
// What the watcher hasn't seen is unknown, and unknown is never stuck: the clock starts the first time a worker is seen
// (after a restart too), and a stall stored before a restart stays until real activity is seen.
//
// Stuck, by kind:
// - quiet: busy, but no change for `quietMs` (6 min), or `longToolMs` (20 min) while a tool it started still runs;
// - loop: the same finished step (same call, same output) `loopRepeats` (6) times in a row at the end of its turn, or the
//   hourly progress check (workerProgress.ts, Ash's 14 Oct rule) found no real progress in its hour;
// - loop also: `sleepWaits` (3) finished shell steps in one turn that wait by sleeping ("sleep 60, check again"), which
//   burns a model call per check (a bookmarked Codex run spent most of a 5-hour limit this way);
// - idle: not busy, nothing holding it (a question, a queued message, a limit it waits out), its row still running, for
//   `idleMs`: it stopped without reporting back.
// A chat that waits on its own workers is never stalled: its workers are judged instead.
import type { Block, Session } from "../../sessions/model/session";

/** A judged stall's kind (`blocked` is declared by the agents, never judged). Same as delegations.ts's StallKind. */
export type StallKind = "quiet" | "loop" | "idle" | "blocked";

export const MIN = 60_000;

export type StallOptions = {
  quietMs: number;
  /** r87: busy with no progress this long after a provider error ("API Error: Server error", "API retry 3 of 10"). */
  providerErrorMs?: number;
  longToolMs: number;
  idleMs: number;
  loopRepeats: number;
  /** Sleep-and-check steps in one turn before it counts as a loop: waiting this way spends a model call each time. */
  sleepWaits?: number;
};

export const STALL_DEFAULTS: StallOptions = {
  quietMs: 6 * MIN,
  providerErrorMs: MIN,
  longToolMs: 20 * MIN,
  idleMs: 6 * MIN,
  loopRepeats: 6,
  sleepWaits: 3,
};

/** `final`: the self-repair gave up; its plain line wins over the watcher's own (selfRepair.ts). */
export type Stall = { kind: StallKind; reason: string; since: number; final?: boolean };

export type WorkerChat = Pick<Session, "busy" | "blocks" | "pendingQuestion" | "queuedMessages" | "queueStatus" | "usageLimit" | "cwd">;

/** What a worker's transcript says right now. */
export type WorkerLook = {
  busy: boolean;
  /** It waits on someone: a question it asked, or an approval. */
  asking: boolean;
  /** A message waits in its queue and will run next (a paused queue holds nothing). */
  queued: boolean;
  /** It stopped at a usage limit and waits it out. */
  limited: boolean;
  /** It gave up resuming itself after restarts and waits for someone to look. */
  resumeStopped: boolean;
  /** The step it is waiting on, when the newest one still runs. */
  runningTool?: string;
  /** The same finished step repeated at the end of this turn. */
  repeat?: { title: string; count: number };
  /** Finished shell steps this turn that waited by sleeping (look.ts isSleepWait). */
  sleepWaits?: number;
  /** How many different steps this turn has taken (progress is this number growing). */
  steps: number;
  /** r87: the provider error the turn's newest step is, while nothing has followed it but retries and thinking. */
  providerError?: string;
};

/** The reason a sleep-and-poll stall carries. */
export const SLEEP_WAIT_PREFIX = "Waiting by sleeping";

/** r87 (s14 r86 run 3): the reason a provider-error stall carries; the Lead is told once, with a retry offered. */
export const PROVIDER_STALL_PREFIX = "Provider error";
const PROVIDER_ERROR = /^\s*(?:API Error\b|API retry \d+ of \d+|.*\b(?:server error|overloaded|503|529)\b.*retry)/i;

/** The provider error at the end of a turn: an error line, then only retries, notices and thinking since. */
export function providerErrorAtEnd(turn: readonly Block[]): string | undefined {
  for (let i = turn.length - 1; i >= 0; i--) {
    const block = turn[i];
    if (block.role === "reasoning") continue;
    const text = (block.text ?? "").trim();
    if ((block.role === "assistant" || block.role === "system") && PROVIDER_ERROR.test(text)) {
      // The first error line of this run of retries names it best ("API Error: Server error mid-response").
      for (let j = i - 1; j >= 0; j--) {
        const earlier = turn[j];
        if (earlier.role === "reasoning") continue;
        if ((earlier.role === "assistant" || earlier.role === "system") && PROVIDER_ERROR.test((earlier.text ?? "").trim()) && /^API Error/i.test(earlier.text.trim()))
          return earlier.text.trim().split("\n")[0].slice(0, 120);
        if (!(earlier.role === "system" && PROVIDER_ERROR.test((earlier.text ?? "").trim()))) break;
      }
      return text.split("\n")[0].slice(0, 120);
    }
    if (block.role === "system" && !text) continue;
    return undefined;
  }
  return undefined;
}

/** What the watcher has seen of one worker chat. */
export type Presence = {
  /** When this window first saw it: the clock starts here, never earlier. */
  watchedSince: number;
  /** The last change it saw in the transcript or the turn, if any. */
  lastChangeAt?: number;
  /** The last time the turn took a step it hadn't taken before. */
  lastProgressAt: number;
  steps: number;
  /** When the current run of repeats was first seen. */
  repeatSince?: number;
  /** r87: when the provider error at the end of its turn was first seen (retry lines that follow don't reset it). */
  errorSince?: number;
};

/** Whether this worker is stuck right now, and how. */
export function judgeStall(
  look: WorkerLook,
  presence: Presence,
  now: number,
  options: StallOptions = STALL_DEFAULTS,
): Stall | null {
  const lastActive = presence.lastChangeAt ?? presence.watchedSince;
  if (look.busy && look.providerError && presence.errorSince !== undefined) {
    const quiet = now - presence.errorSince;
    if (quiet >= (options.providerErrorMs ?? MIN))
      return {
        kind: "quiet",
        reason: `${PROVIDER_STALL_PREFIX}, no progress for ${Math.round(quiet / 1000)}s: ${look.providerError}`,
        since: presence.errorSince,
      };
  }
  if (look.busy) {
    if (look.repeat && look.repeat.count >= options.loopRepeats)
      return {
        kind: "loop",
        reason: `Repeating the same step: ${look.repeat.title} (${look.repeat.count} times)`,
        since: presence.repeatSince ?? now,
      };
    if ((look.sleepWaits ?? 0) >= (options.sleepWaits ?? 3))
      return {
        kind: "loop",
        reason: `${SLEEP_WAIT_PREFIX} (${look.sleepWaits} sleep steps this turn). Each check costs a model call: end the turn and report what it waits on, and its first mate sets a timer.`,
        since: presence.repeatSince ?? presence.lastProgressAt,
      };
    const wait = look.runningTool ? options.longToolMs : options.quietMs;
    if (!look.asking && now - lastActive >= wait)
      return {
        kind: "quiet",
        reason: look.runningTool ? `Still running ${look.runningTool}` : "",
        since: lastActive,
      };
    // An hour with no real progress is the hourly check's to judge (selfRepair.ts), on more than new steps.
    return null;
  }
  if ((look.asking || look.queued || look.limited) && !look.resumeStopped) return null;
  if (now - lastActive >= options.idleMs)
    return {
      kind: "idle",
      reason: look.resumeStopped ? "Stopped resuming itself after restarts" : "Stopped without reporting back",
      since: lastActive,
    };
  return null;
}
