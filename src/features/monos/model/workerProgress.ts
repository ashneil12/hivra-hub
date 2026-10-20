// The hourly progress check and self-repair for delegated workers (board item H2; Ash, 14 Oct: "remove a cap n instead
// think of something better like if its running for more than an hour the main agent checks that progress is still
// being made or not", and "n no cost ceiling ill handle it"). It extends the stall watcher (workerStall.ts), which
// judges minutes-scale silence and loops; this judges the hour, and repairs what it can.
//
// The hour. When a worker has run for about an hour, and every hour after, its real progress since the last check is
// read: commits in its folder, files changed (the folder's diff and the edits it made), test runs that passed, and new
// messages. Time passing is not progress.
// - Something real moved: it keeps going. Nothing is said anywhere (no spam).
// - Only talk: it keeps going once; a second hour of only talk is stuck.
// - Nothing moved, the same error over and over, or failing tests with nothing changed: stuck. The first time, the
//   worker is told to try another way (the retry) and its Lead hears why, privately. Each further stuck hour in a row
//   asks its Lead to stop it, split it or retry it (its call), and the second one is flagged to Ash. Either way the
//   worker shows as stuck with a plain line (the stall on its row), so the "N stuck" line opens it with a one-tap reply,
//   and Ash gets the native banner the stuck notifier already sends. Real progress (a commit, a changed file, a passing
//   test) clears it within a couple of minutes.
// - Long runs (every 3 h) and costly ones (every 5 million tokens) are flagged to Ash: a banner, never a stop.
// There is no step cap and no cost ceiling.
//
// Self-repair. A worker that crashed (a transient provider failure or its process dying, its Lead not yet told) or hung
// (no output for the stall time while busy, or idle without reporting back) is retried with backoff: 1, 5, then 15
// minutes after it went wrong. A hung busy worker is nudged first and restarted after; the rest are continued. After
// three tries it is left stuck and its Lead hears that the repair gave up. A fault only starts over once the worker has
// run cleanly for half an hour, so a crash loop can't be retried for ever. A question, a usage limit, a billing or
// sign-in refusal, and anything Ash stopped are never retried.
//
// What this window hasn't seen is unknown, and unknown is never stuck: the hour starts the first time a worker is seen
// here (after a restart too), like the stall watcher's clock.
import { isProviderErrorClass } from "../../../integrations/harness/core/providerFailure";
import { CONTINUE_PROMPT } from "../../sessions/model/inFlight";
import { toolCallState } from "../../sessions/model/transcriptActivity";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation, type DelegationTracker } from "./delegations";
import type { Stall } from "./workerStall";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** How long a repaired worker must run cleanly before a later fault gets fresh tries. */
const REPAIR_RESET_MS = 30 * MIN;

export type ProgressOptions = {
  /** First check after this long running, then every `everyMs`. */
  firstMs: number;
  everyMs: number;
  /** After a stuck verdict, how often real progress is looked for (to clear it). */
  relookMs: number;
  /** A failing step with the same error this many times in a row is stuck, whatever else moved. */
  repeatedErrors: number;
  /** Flag a run to Ash each time it passes another multiple of this. */
  longRunMs: number;
  /** Flag a run to Ash each time its tokens pass another multiple of this. */
  costlyTokens: number;
  /** Self-repair: the wait before each try, from when it went wrong; its length is the number of tries. */
  repairBackoffMs: readonly number[];
};

export const PROGRESS_DEFAULTS: ProgressOptions = {
  firstMs: HOUR,
  everyMs: HOUR,
  relookMs: 2 * MIN,
  repeatedErrors: 5,
  longRunMs: 3 * HOUR,
  costlyTokens: 5_000_000,
  repairBackoffMs: [MIN, 5 * MIN, 15 * MIN],
};

// ---- reading a worker's transcript ---------------------------------------------------------------------------------------

/** Running totals over a worker's whole chat. Progress is how they grow between two checks. */
export type WorkerTally = {
  edits: number;
  testsPassed: number;
  testsFailed: number;
  /** Distinct things it said. */
  messages: number;
  /** The newest failed step's error and how many failed steps in a row ended with it. */
  errorRun?: { text: string; count: number };
  /** Tokens it has used: input, output and cache writes (cache reads are cheap and left out). */
  tokens: number;
};

const TEST_RUN =
  /\b(vitest|jest|pytest|mocha|playwright test|cargo test|go test|(npm|pnpm|yarn|bun) (run )?test|node --test|unittest|rspec|phpunit|swift test|xcodebuild test)\b/i;
const TEST_FAILED = /\b[1-9]\d*\s+(failed|failing|failures?)\b|\btests? failed\b|^\s*FAIL\b/im;

function isEdit(block: Block): boolean {
  const tool = block.tool;
  if (!tool) return false;
  return tool.preview?.kind === "write" || tool.kind === "edit" || /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)\b/.test(tool.title ?? block.text);
}

function isTestRun(block: Block): boolean {
  const tool = block.tool;
  if (!tool) return false;
  const shell = tool.kind === "execute" || tool.preview?.kind === "shell" || /^(Bash|Run|Shell)\b/i.test(tool.title ?? "");
  return shell && TEST_RUN.test(`${tool.title ?? ""} ${block.text}`);
}

const errorText = (block: Block) => (block.tool?.detail || block.tool?.title || block.text).trim().split("\n")[0].slice(0, 200);

export function tallyTranscript(blocks: readonly Block[]): WorkerTally {
  let edits = 0;
  let testsPassed = 0;
  let testsFailed = 0;
  let tokens = 0;
  const said = new Set<string>();
  const failures: string[] = [];
  for (const block of blocks) {
    if (block.role === "user" && block.turnMetrics) {
      const m = block.turnMetrics;
      tokens += (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheWriteTokens ?? 0);
    }
    if (block.role === "assistant" && block.text.trim()) said.add(block.text.trim());
    if (block.role !== "tool" || !block.tool) continue;
    const state = toolCallState(block);
    if (state === "pending") continue;
    const failed = state === "rejected";
    if (isTestRun(block)) {
      if (failed || TEST_FAILED.test(block.tool.detail ?? "")) testsFailed++;
      else testsPassed++;
    } else if (isEdit(block) && !failed) edits++;
    if (failed) failures.push(errorText(block));
  }
  let errorRun: WorkerTally["errorRun"];
  if (failures.length) {
    const text = failures[failures.length - 1];
    let count = 0;
    for (let i = failures.length - 1; i >= 0 && failures[i] === text; i--) count++;
    errorRun = { text, count };
  }
  return { edits, testsPassed, testsFailed, messages: said.size, ...(errorRun ? { errorRun } : {}), tokens };
}

// ---- judging an hour ----------------------------------------------------------------------------------------------------

/** What its folder says (the app's own git reads). Null when it isn't a repo or can't be read. */
export type FolderLook = { commits: number; diff: { files: number; additions: number; deletions: number } };

/** What moved between two checks. */
export type ProgressSignals = {
  commits: number;
  /** Its folder's uncommitted changes moved, or it edited files. */
  filesChanged: boolean;
  testsPassed: number;
  testsFailed: number;
  messages: number;
  /** The same error, this many times in a row, newer than the last check. */
  repeatedError?: { text: string; count: number };
};

export type Snapshot = { at: number; tally: WorkerTally; diff: string | null };

export function progressSignals(before: Snapshot, after: Snapshot, commits: number, options = PROGRESS_DEFAULTS): ProgressSignals {
  const grew = (key: "edits" | "testsPassed" | "testsFailed" | "messages") => Math.max(0, after.tally[key] - before.tally[key]);
  const run = after.tally.errorRun;
  const was = before.tally.errorRun;
  const repeated = run && run.count >= options.repeatedErrors && (!was || was.text !== run.text || run.count > was.count) ? run : undefined;
  return {
    commits,
    filesChanged: grew("edits") > 0 || (after.diff !== null && before.diff !== null && after.diff !== before.diff),
    testsPassed: grew("testsPassed"),
    testsFailed: grew("testsFailed"),
    messages: grew("messages"),
    ...(repeated ? { repeatedError: repeated } : {}),
  };
}

export type Verdict = { verdict: "keep_going" | "stuck"; reason: string; talkOnly: boolean };

/** One plain line of what moved: "2 commits, files changed, tests passing". */
export function movedLine(s: ProgressSignals): string {
  return [
    s.commits ? `${s.commits} commit${s.commits === 1 ? "" : "s"}` : "",
    s.filesChanged ? "files changed" : "",
    s.testsPassed ? "tests passing" : "",
    s.messages ? `${s.messages} message${s.messages === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(", ") || "nothing";
}

/** The plain rule (Ash OS's hourly check falls back on the same one, ashos/jobs.py `_heuristic`). */
export function judgeProgress(s: ProgressSignals, talkedOnlyLastHour: boolean): Verdict {
  if (s.repeatedError)
    return { verdict: "stuck", reason: `The same error came up ${s.repeatedError.count} times in a row`, talkOnly: false };
  if (s.commits || s.filesChanged || s.testsPassed)
    return { verdict: "keep_going", reason: `Moving: ${movedLine(s)}`, talkOnly: false };
  if (s.testsFailed)
    return { verdict: "stuck", reason: "Tests keep failing and nothing has changed", talkOnly: false };
  if (s.messages)
    return talkedOnlyLastHour
      ? { verdict: "stuck", reason: "Talking, but nothing saved or tested for two hours", talkOnly: true }
      : { verdict: "keep_going", reason: "Only talking this hour; nothing saved yet", talkOnly: true };
  return { verdict: "stuck", reason: "Nothing moved in the last hour", talkOnly: false };
}

// ---- the watcher ----------------------------------------------------------------------------------------------------------

type WorkerChat = Pick<Session, "busy" | "blocks" | "cwd" | "pendingQuestion" | "usageLimit" | "queuedMessages" | "queueStatus">;

/** What the check needs from the app. Every hand is the app's own: nothing here runs a model or a shell. */
export type ProgressHost = {
  tracker(): DelegationTracker | null;
  session(id: string): WorkerChat | undefined;
  /** How many open rows a chat owns (a chat waiting on its own workers is judged through them). */
  openOwned(chat: string): number;
  /** Its folder since `sinceMs`. */
  folder(cwd: string, sinceMs: number): Promise<FolderLook | null>;
  /** A private note into the Lead's (owner's) chat, as an app notification, never as Ash. */
  tellLead(row: Delegation, text: string): void | Promise<void>;
  /** A message into the worker's chat: it steers a running turn, or starts the next one. */
  message(row: Delegation, text: string): Promise<boolean>;
  /** Stop the worker's running turn (its own chat only), before it is continued: a restart for a hung worker. */
  stopTurn(row: Delegation): Promise<boolean>;
  /** Its unread failure report won't be needed (it is being retried): out of the Lead's queue. */
  dropReport?(row: Delegation): void;
  /** Tell Ash (a native banner). */
  flagAsh(row: Delegation, text: string): void;
  now?(): number;
  options?(): ProgressOptions;
};

type Watched = {
  since: number;
  lastCheckAt: number;
  base: Snapshot;
  stuckInARow: number;
  talkedOnly: boolean;
  verdict?: Stall;
  relookAt?: number;
  longFlags: number;
  tokenFlags: number;
  repair?: { episode: string; tries: number; nextAt: number; gaveUp: boolean; okSince?: number; restarting?: boolean };
  busy?: boolean;
};

const goalOf = (row: Delegation) => (row.goal || row.title || row.brief || "its task").trim().split("\n")[0].slice(0, 160);
const titleOf = (row: Delegation) => (row.title || "Delegated work").trim();

/** The note a worker gets when an hour moved nothing: the retry. */
export function retryMessage(row: Delegation, reason: string): string {
  return `Hourly check from your Lead: no real progress toward "${goalOf(row)}" in the last hour (${reason.toLowerCase()}). Stop what isn't working, say in one line what's blocking you, then try a different way. If it's too big for one go, say how you'd split it.`;
}

/**
 * The Lead's private note: a hidden app turn that shows as one quiet line ("From Hourly check"), never as Ash's words.
 * One per row and hour (its id), so a note can't be queued twice.
 */
export function progressNoteMessage(row: Pick<Delegation, "id" | "childSession">, text: string, at: number): QueuedMessage {
  return {
    id: `progress-check-${row.id}-${Math.floor(at / 60_000)}`,
    attachments: [],
    monoNote: { kind: "message", from: "Hourly check", line: text.length > 160 ? `${text.slice(0, 159)}…` : text },
    text: `[MonoCode hourly check] ${text}\n\nThis is an app notification about work you delegated (worker chat ${row.childSession}), not a new message from Ash. Read the worker's chat if you need more before you decide.`,
  };
}

const NUDGE = "Check-in from the app: there's been no output for a while. If a command is stuck, stop it and carry on, and say where you are.";

/** A failure the app may retry by itself: a passing provider fault or the process dying, never a refusal or a limit. */
export function repairableFailure(row: Pick<Delegation, "state" | "errorClass" | "error" | "retryable" | "delivery">): boolean {
  if (row.state !== "failed" || row.retryable === false) return false;
  // Its Lead already read the failure: what happens next is the Lead's call.
  if (row.delivery === "delivered" || row.delivery === "acknowledged" || row.delivery === "disposed") return false;
  if (isProviderErrorClass(row.errorClass)) return row.errorClass === "overloaded" || row.errorClass === "provider_error";
  return /\b(exited|crash(ed)?|killed|signal|broken pipe|ECONNRESET|socket hang up|terminated|timed out)\b/i.test(row.error ?? "");
}

/**
 * One per main window, next to the stall watcher: `tick` on the stall watcher's half-minute look. `stallFor` is what
 * the stall watcher writes on a row while this check holds it stuck.
 */
export class ProgressCheck {
  private watched = new Map<string, Watched>();
  private running = false;

  constructor(private host: ProgressHost) {}

  private now() {
    return (this.host.now ?? Date.now)();
  }
  private options() {
    return this.host.options?.() ?? PROGRESS_DEFAULTS;
  }

  /** The hourly check's stuck verdict for this row, if it holds one. */
  stallFor(row: Pick<Delegation, "id">): Stall | null {
    return this.watched.get(row.id)?.verdict ?? null;
  }

  /** Tests and the UI: what the check last made of a row. */
  state(rowId: string): Readonly<Watched> | undefined {
    return this.watched.get(rowId);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tracker = this.host.tracker();
      if (!tracker?.isLoaded()) return;
      const rows = tracker.known();
      // A worker mid-restart reads cancelled for a moment (its turn was stopped): it stays watched until it's continued.
      const live = new Set(
        rows
          .filter((row) => row.state === "running" || row.state === "failed" || this.watched.get(row.id)?.repair?.restarting)
          .map((row) => row.id),
      );
      for (const id of this.watched.keys()) if (!live.has(id)) this.watched.delete(id);
      for (const row of rows) {
        try {
          await this.look(row);
        } catch (error) {
          console.error("The hourly check could not look at a worker", error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async look(row: Delegation) {
    const chat = this.host.session(row.childSession);
    if (!chat) return; // Not this window's: unknown, never stuck.
    const now = this.now();
    let w = this.watched.get(row.id);
    if (!w) {
      if (row.state !== "running") return; // A failure seen before it ever ran here is its Lead's.
      const folder = await this.host.folder(chat.cwd, now).catch(() => null);
      w = { since: now, lastCheckAt: now, base: { at: now, tally: tallyTranscript(chat.blocks), diff: folder ? JSON.stringify(folder.diff) : null }, stuckInARow: 0, talkedOnly: false, longFlags: 0, tokenFlags: 0 };
      this.watched.set(row.id, w);
      return;
    }
    await this.repair(row, chat, w, now);
    if (row.state !== "running" || !isOpenDelegation(row)) return;
    // Waiting on someone (a question, a limit) or on its own workers is not a stuck hour.
    const holding = !!chat.pendingQuestion || !!chat.usageLimit || this.host.openOwned(row.childSession) > 0;
    if (holding) {
      w.lastCheckAt = Math.max(w.lastCheckAt, now - this.options().everyMs + this.options().relookMs);
      return;
    }
    this.flagCost(row, chat, w, now);
    if (w.verdict && w.relookAt !== undefined && now >= w.relookAt) await this.relook(chat, w, now);
    const o = this.options();
    const due = now - w.since >= o.firstMs && now - w.lastCheckAt >= o.everyMs;
    if (due) await this.check(row, chat, w, now);
  }

  private async read(chat: WorkerChat, since: number, now: number) {
    const folder = await this.host.folder(chat.cwd, since).catch(() => null);
    const snap: Snapshot = { at: now, tally: tallyTranscript(chat.blocks), diff: folder ? JSON.stringify(folder.diff) : null };
    return { snap, commits: folder?.commits ?? 0 };
  }

  /** The hour's check. */
  private async check(row: Delegation, chat: WorkerChat, w: Watched, now: number) {
    const { snap, commits } = await this.read(chat, w.lastCheckAt, now);
    const signals = progressSignals(w.base, snap, commits, this.options());
    const verdict = judgeProgress(signals, w.talkedOnly);
    w.lastCheckAt = now;
    w.base = snap;
    // An hour of only talk, or a stuck one, means the next hour of only talk is stuck too.
    w.talkedOnly = verdict.talkOnly || verdict.verdict === "stuck";
    if (verdict.verdict === "keep_going") {
      w.stuckInARow = 0;
      if (!verdict.talkOnly) this.clear(w);
      return;
    }
    w.stuckInARow++;
    const title = titleOf(row);
    if (w.stuckInARow === 1) {
      w.verdict = { kind: "loop", reason: `No real progress in the last hour: ${lowerFirst(verdict.reason)} · asked it to try another way`, since: now };
      w.relookAt = now + this.options().relookMs;
      await this.host.message(row, retryMessage(row, verdict.reason)).catch(() => false);
      await this.host.tellLead(
        row,
        `Hourly check on "${title}": no real progress in the last hour (${lowerFirst(verdict.reason)}). I asked it to try another way and I'll check again in an hour. If you can see it won't move, split it into smaller pieces or stop it.`,
      );
      return;
    }
    // Stopping, splitting or retrying it is its Lead's call (Ash's words: the main agent checks). It stays marked stuck,
    // red, with a one-tap reply for Ash, until real progress clears it or someone moves it (D5: red Stuck stays).
    const hours = w.stuckInARow;
    w.verdict = {
      kind: "loop",
      reason: `No real progress for ${hours} hours: ${lowerFirst(verdict.reason)} · its Lead was asked to stop, split or retry it`,
      since: w.verdict?.since ?? now,
    };
    w.relookAt = now + this.options().relookMs;
    await this.host.tellLead(
      row,
      `Hourly check on "${title}": still no real progress after ${hours} hours (${lowerFirst(verdict.reason)}). Decide now: stop it, split it into smaller pieces and brief them, or retry it with a clearer brief. If only Ash can unblock it, tell him in one line with your pick. It stays marked stuck until it moves.`,
    );
    if (hours === 2) this.host.flagAsh(row, `Stuck: no real progress for 2 hours. Its Lead has been asked to stop, split or retry it.`);
  }

  /** After a stuck verdict: a commit, a changed file or a passing test clears it at once. */
  private async relook(chat: WorkerChat, w: Watched, now: number) {
    w.relookAt = now + this.options().relookMs;
    const { snap, commits } = await this.read(chat, w.lastCheckAt, now);
    const s = progressSignals(w.base, snap, commits, this.options());
    if (s.commits || s.filesChanged || s.testsPassed) {
      w.stuckInARow = 0;
      w.talkedOnly = false;
      w.base = snap;
      w.lastCheckAt = now;
      this.clear(w);
    }
  }

  private clear(w: Watched) {
    delete w.verdict;
    delete w.relookAt;
  }

  /** Long and costly runs: told to Ash, never stopped (no cost ceiling). */
  private flagCost(row: Delegation, chat: WorkerChat, w: Watched, now: number) {
    const o = this.options();
    const long = Math.floor((now - w.since) / o.longRunMs);
    if (long > w.longFlags) {
      w.longFlags = long;
      const hours = Math.round(((now - w.since) / HOUR) * 10) / 10;
      const state = w.verdict ? "it's marked stuck" : w.talkedOnly ? "it's talking but hasn't saved anything this hour" : "it's still moving";
      this.host.flagAsh(row, `Running ${hours} h and ${state}. There's no time cap; just letting you know.`);
    }
    const tokens = tallyTranscript(chat.blocks).tokens;
    const costly = Math.floor(tokens / o.costlyTokens);
    if (costly > w.tokenFlags) {
      w.tokenFlags = costly;
      this.host.flagAsh(row, `Has used about ${(tokens / 1_000_000).toFixed(1)} million tokens on this run. There's no cost cap; just letting you know.`);
    }
  }

  /** Self-repair: a crashed or hung worker is retried with backoff, three times at most. */
  private async repair(row: Delegation, chat: WorkerChat, w: Watched, now: number) {
    const o = this.options();
    if (w.repair?.restarting) {
      if (chat.busy) return; // The stop hasn't landed yet.
      w.repair.restarting = false;
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
      if (w.repair && row.state === "running" && !row.stallKind) {
        w.repair.okSince ??= now;
        if (now - w.repair.okSince >= REPAIR_RESET_MS) delete w.repair;
      }
      return;
    }
    if (!w.repair) w.repair = { episode, tries: 0, nextAt: wentWrongAt + o.repairBackoffMs[0], gaveUp: false };
    const r = w.repair;
    if (r.episode !== episode) {
      // A new fault in the same run: it waits its own backoff, and the tries carry on counting.
      r.episode = episode;
      r.nextAt = Math.max(r.nextAt, wentWrongAt + (o.repairBackoffMs[Math.min(r.tries, o.repairBackoffMs.length - 1)] ?? 0));
    }
    delete r.okSince;
    if (r.gaveUp || now < r.nextAt) return;
    if (r.tries >= o.repairBackoffMs.length) {
      r.gaveUp = true;
      await this.host.tellLead(
        row,
        `Self-repair gave up on "${titleOf(row)}" after ${r.tries} tries: ${row.state === "failed" ? lowerFirst(row.error?.trim() || "it keeps failing") : "it keeps going quiet"}. It's marked stuck; decide whether to retry it differently or tell Ash.`,
      );
      return;
    }
    r.tries++;
    r.nextAt = now + (o.repairBackoffMs[r.tries] ?? o.repairBackoffMs[o.repairBackoffMs.length - 1]);
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

const lowerFirst = (text: string) => (text[0] && text[1] && text[1] === text[1].toLowerCase() ? text[0].toLowerCase() + text.slice(1) : text);
