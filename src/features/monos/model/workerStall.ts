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
import { toolCallLabel, toolCallState } from "../../sessions/model/transcriptActivity";
import type { Block, Session } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation, type DelegationTracker, type StallKind } from "./delegations";

const MIN = 60_000;

export type StallOptions = {
  quietMs: number;
  longToolMs: number;
  idleMs: number;
  loopRepeats: number;
};

export const STALL_DEFAULTS: StallOptions = {
  quietMs: 6 * MIN,
  longToolMs: 20 * MIN,
  idleMs: 6 * MIN,
  loopRepeats: 6,
};

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

/** `final`: the self-repair gave up; its plain line wins over the watcher's own (selfRepair.ts). */
export type Stall = { kind: StallKind; reason: string; since: number; final?: boolean };

type WorkerChat = Pick<Session, "busy" | "blocks" | "pendingQuestion" | "queuedMessages" | "queueStatus" | "usageLimit" | "cwd">;

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
  /** How many different steps this turn has taken (progress is this number growing). */
  steps: number;
};

/** The blocks of the turn running now (or the last one): everything after its user message. */
function currentTurn(blocks: readonly Block[]): readonly Block[] {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].role === "user") return blocks.slice(i + 1);
  return blocks;
}

const callOf = (block: Block) => {
  const preview = block.tool?.preview;
  return JSON.stringify([block.tool?.kind ?? "", block.text || block.tool?.title || "", preview?.path ?? "", preview?.query ?? ""]);
};
const resultOf = (block: Block) =>
  JSON.stringify([callOf(block), block.tool?.status ?? "", (block.tool?.detail ?? "").slice(0, 4_000)]);

export function lookAt(chat: WorkerChat): WorkerLook {
  const turn = currentTurn(chat.blocks);
  const tools = turn.filter((block) => block.role === "tool" && block.tool);
  const last = tools[tools.length - 1];
  const running = last && toolCallState(last) === "pending" && !last.approval ? last : undefined;
  const finished = running ? tools.slice(0, -1) : tools;
  let repeat: WorkerLook["repeat"];
  if (finished.length) {
    const tail = resultOf(finished[finished.length - 1]);
    let count = 0;
    for (let i = finished.length - 1; i >= 0 && resultOf(finished[i]) === tail; i--) count++;
    if (count > 1) repeat = { title: toolCallLabel(finished[finished.length - 1], chat.cwd), count };
  }
  const distinct = new Set(tools.map(callOf));
  const said = turn.filter((block) => block.role === "assistant" && block.text.trim()).length;
  const approval = turn.some((block) => !!block.approval && !block.approval.decided);
  const lastBlock = chat.blocks[chat.blocks.length - 1];
  return {
    busy: !!chat.busy,
    asking: !!chat.pendingQuestion || approval,
    queued: !!chat.queuedMessages?.length && chat.queueStatus !== "paused",
    limited: !!chat.usageLimit,
    resumeStopped: lastBlock?.notice === "resume-stopped",
    ...(running ? { runningTool: toolCallLabel(running, chat.cwd) } : {}),
    ...(repeat ? { repeat } : {}),
    steps: distinct.size + said,
  };
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
};

/** Whether this worker is stuck right now, and how. */
export function judgeStall(
  look: WorkerLook,
  presence: Presence,
  now: number,
  options: StallOptions = STALL_DEFAULTS,
): Stall | null {
  const lastActive = presence.lastChangeAt ?? presence.watchedSince;
  if (look.busy) {
    if (look.repeat && look.repeat.count >= options.loopRepeats)
      return {
        kind: "loop",
        reason: `Repeating the same step: ${look.repeat.title} (${look.repeat.count} times)`,
        since: presence.repeatSince ?? now,
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
};

type Seen = Presence & { fingerprint: readonly unknown[] };

/**
 * One per main window: `sync` on every change to the chats (it notes what moved, and clears a stall the moment its
 * worker moves again), `tick` every half minute (it raises the stalls). Each change reaches the row once.
 */
export class StallWatch {
  private seen = new Map<string, Seen>();
  private writing = new Set<string>();

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

  private judge(row: Delegation, mode: "clear" | "both") {
    const chat = this.host.session(row.childSession);
    if (!chat) return; // Not this window's: unknown, never stuck.
    const now = this.now();
    const seen = this.presence(row, chat, now);
    const stored = row.stallKind ?? null;
    // A declared block (task_cannot) is the agent's own word, not a judgment: the watcher never overwrites or clears it.
    // It stands until the row itself moves (a settle, a Stop, a retried generation), which clears the stall in Rust.
    if (stored === "blocked") return;
    const moved = (seen.lastChangeAt ?? 0) > (row.stalledAt ?? 0);
    // Between looks only a stalled worker that moved is judged (to clear it at once); the rest wait for the look.
    if (mode === "clear" && !(stored && moved)) return;
    const look = lookAt(chat);
    if (mode === "both") this.progress(seen, look, now);
    const waitsOnWorkers = this.host.openOwned(row.childSession) > 0;
    const own = waitsOnWorkers ? null : judgeStall(look, seen, now, this.host.options?.() ?? stallOptions());
    // Silence now (quiet, idle) says more than the hour's verdict; otherwise the hour's verdict stands while it holds.
    const hourly = waitsOnWorkers ? null : (this.host.hourly?.(row) ?? null);
    const stall = hourly?.final ? hourly : own && own.kind !== "loop" ? own : (hourly ?? own);
    const changed = !!stall && (stall.kind !== stored || stall.reason !== (row.stallReason ?? ""));
    if (stall && changed && mode === "both") this.write(row, stall);
    // A stall only clears on something seen: activity after it began, or the worker now waiting on its own workers.
    else if (!stall && stored && (moved || waitsOnWorkers)) this.write(row, null);
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

  /** The half-minute look: raise and clear. */
  tick(): void {
    const rows = this.running();
    const live = new Set(rows.map((row) => row.childSession));
    for (const child of this.seen.keys()) if (!live.has(child)) this.seen.delete(child);
    for (const row of rows) this.judge(row, "both");
  }
}
