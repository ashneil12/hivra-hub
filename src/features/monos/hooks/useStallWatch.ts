// Runs the stall watcher (model/workerStall.ts) in the main window, where the workers' turns run: every change to the
// chats is noted (a stalled worker that moves again is cleared at once), and every half minute the running rows are
// judged, so a stalled worker shows everywhere within about a minute of crossing its limit. The same look sends the
// hourly progress check (model/hourlyCheck.ts, board H2): one line to the owner of a worker running over an hour, with
// the evidence the app read itself (model/progressCheck.ts) — commits, changed files, passing and failing test runs, or
// plainly that nothing moved, and since 23 Oct the judge's verdict on it (model/workerProgress.ts). Self-repair
// (model/selfRepair.ts, board H3) retries a crashed or hung worker, or one the judge found with nothing moving after an
// hour, with backoff before its Lead is told. Harness care (model/harnessCare.ts, board H1/H3) looks after the app's
// surroundings on the same look: its database check, a stuck ship trial, a pull request watch whose reads keep failing, a
// chat the app stopped continuing, delegated work whose chat is gone (model/careFaults.ts reads them in). The same window
// announces stuck workers with a native banner (useStuckNotifications), except a Lead's own stalled or crashed workers:
// their Lead handles those, and tells Ash in its own chat when only he can help.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { isOpenDelegation, storedResult, type DelegationTracker } from "../model/delegations";
import { currentWakeQueue } from "../../firstmate/watcher/wakeQueue";
import type { MonoSessionCompletionResult } from "../model/monoSessionCompletion";
import { providerStallChatLine, providerStallNote, sleepGap, StallWatch } from "../model/workerStall";
import { careFaults, type DatabaseHealth } from "../model/careFaults";
import { HarnessCare, resumeStoppedNote, SAFE_FIXES } from "../model/harnessCare";
import { addHarnessIssue, clearHarnessIssue } from "../../hub/model/harnessIssues";
import { recordBotNote } from "../../hub/model/botChanges";
import { tauriPrWatches, type PrWatch } from "../../pr-watch/model/prWatches";
import { shipStatus } from "../../../app/model/ship";
import { HOUR_MS, hourlyCheckMessage, hourlyChecksDue } from "../model/hourlyCheck";
import { evidenceOf, evidenceSince, newestWord, tallyTranscript, type FolderLook, type Look } from "../model/progressCheck";
import { judgeWorkerProgress, type WorkerJudgement } from "../model/workerProgress";
import { repairNoteMessage, SelfRepair } from "../model/selfRepair";
import { faultOf, HarnessRepair, type HarnessFault } from "../model/harnessRepair";
import { gitDiffStats, gitHistory } from "../../../platform/tauri/fs";
import { sendToChat } from "../../hub/model/waitingChats";
import { dismissQueuedMonoSessionCompletion, type MonoSessionCompletionBatches } from "../model/monoSessionCompletion";
import type { Delegation } from "../model/delegations";
import { appIdentity } from "../../../app/model/appIdentity";
import { useStuckNotifications } from "../../notifications/hooks/useStuckNotifications";

export const STALL_LOOK_MS = 30_000;

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

export function useStallWatch(options: {
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  tracker: () => DelegationTracker | null;
  /** How the hourly check reaches a worker's owner (useDelegationTree passes its own options through). */
  queueWake?: (owner: string, message: QueuedMessage) => Promise<void> | void;
  /** Self-repair's hands: stop a hung worker's turn, and drop a report it no longer needs. */
  stopSession?: (sessionId: string, managed?: boolean) => Promise<unknown> | void;
  batches?: () => MonoSessionCompletionBatches | null;
  setSessions?: Dispatch<SetStateAction<Session[]>>;
  /** The app's Try again, for harness self-repair (harnessRepair.ts): a chat's own failed turn. */
  retryTurn?: (sessionId: string) => boolean;
}): void {
  const latest = useRef(options);
  latest.current = options;
  const openOwned = (chat: string) =>
    latest.current
      .tracker()
      ?.known()
      .filter((row) => row.ownerSession === chat && isOpenDelegation(row)).length ?? 0;
  const session = (id: string) => latest.current.sessionsRef.current.find((entry) => entry.id === id);
  // When each row's owner was last asked; a fresh window asks again after an hour of its own.
  const asked = useRef(new Map<string, number>());
  const born = useRef(Date.now());
  // What each worker's last hourly check saw, so the next one reports what moved in between rather than re-reading the lot.
  const looks = useRef(new Map<string, { at: number; look: Look }>());
  // What the judge made of a worker for self-repair, kept a few minutes so a half-minute tick doesn't re-read its folder.
  const readings = useRef(new Map<string, { at: number; judgement: WorkerJudgement }>());
  /** A worker's folder since `sinceMs`, through the app's own git reads. Null when it isn't a repo or can't be read. */
  const folder = async (cwd: string | undefined, sinceMs: number): Promise<FolderLook | null> => {
    if (!cwd) return null;
    try {
      const [history, diff] = await Promise.all([gitHistory(cwd, 100), gitDiffStats(cwd)]);
      return {
        commits: history.commits.filter((commit) => commit.timestamp * 1_000 >= sinceMs).length,
        files: diff.files,
        additions: diff.additions,
        deletions: diff.deletions,
      };
    } catch {
      // Not a repo, or the app couldn't read it: the owner gets the plain ask, with no evidence claimed.
      return null;
    }
  };
  /** The worker's own last word, for the judge's line: its report to the Lead, else the newest thing it said. */
  const reportOf = (row: Delegation, child: Session | undefined) => row.result?.trim() || newestWord(child?.blocks ?? []);
  const hourly = async (every: number) => {
    const rows = latest.current.tracker()?.known() ?? [];
    const now = Date.now();
    for (const id of looks.current.keys()) if (!rows.some((row) => row.id === id && isOpenDelegation(row))) looks.current.delete(id);
    for (const id of hourlyChecksDue(rows, asked.current, now, every)) {
      const row = rows.find((entry) => entry.id === id)!;
      if (!asked.current.has(id) && now - born.current < every) continue;
      asked.current.set(id, now);
      const child = session(row.childSession);
      const before = looks.current.get(id);
      const since = before?.at ?? row.createdAt;
      const look: Look = { tally: tallyTranscript(child?.blocks ?? []), folder: await folder(child?.cwd, since) };
      const evidence = before ? evidenceSince(before.look, look) : evidenceOf(look);
      looks.current.set(id, { at: now, look });
      void latest.current.queueWake?.(
        row.ownerSession,
        hourlyCheckMessage(row, now, {
          evidence,
          windowMinutes: Math.round((now - since) / 60_000),
          judgement: judgeWorkerProgress({ look, report: reportOf(row, child), minutes: Math.round((now - row.createdAt) / 60_000) }),
        }),
      );
    }
    for (const id of readings.current.keys()) if (!rows.some((row) => row.id === id && isOpenDelegation(row))) readings.current.delete(id);
  };
  /** How often self-repair re-reads a worker it is already watching: each try after the first sees fresh facts. */
  const READING_MS = 5 * 60_000;
  /**
   * Self-repair's hand (workerProgress.ts): what the app reads about a worker running over an hour, from its own chat
   * and folder. Younger rows get nothing: the judge is for work past the hourly mark, not for a slow first minute.
   */
  const read = async (row: Delegation): Promise<WorkerJudgement | undefined> => {
    if (row.state !== "running") return undefined;
    const now = Date.now();
    if (now - row.createdAt < HOUR_MS) return undefined;
    const cached = readings.current.get(row.id);
    if (cached && now - cached.at < READING_MS) return cached.judgement;
    const child = session(row.childSession);
    if (!child) return undefined;
    const look: Look = { tally: tallyTranscript(child.blocks), folder: await folder(child.cwd, row.createdAt) };
    const judgement = judgeWorkerProgress({ look, report: reportOf(row, child), minutes: Math.round((now - row.createdAt) / 60_000) });
    readings.current.set(row.id, { at: now, judgement });
    return judgement;
  };
  const repair = useRef<SelfRepair | null>(null);
  repair.current ??= new SelfRepair({
    tracker: () => latest.current.tracker(),
    session,
    tellLead: (row: Delegation, text: string) => latest.current.queueWake?.(row.ownerSession, repairNoteMessage(row, text, Date.now())),
    message: (row: Delegation, text: string) => sendToChat(row.childSession, text),
    stopTurn: async (row: Delegation) => {
      await latest.current.stopSession?.(row.childSession);
      return true;
    },
    dropReport: (row: Delegation) => {
      latest.current.batches?.()?.dismissSession(row.ownerSession, row.childSession);
      latest.current.setSessions?.((previous) =>
        previous.map((entry) => (entry.id === row.ownerSession ? dismissQueuedMonoSessionCompletion(entry, row.childSession) : entry)),
      );
    },
    reading: read,
  });
  // The general half of self-repair (board H1/H3): a chat's own failed turn, tried again by the app before anyone asks.
  const harness = useRef<HarnessRepair | null>(null);
  harness.current ??= new HarnessRepair({
    retry: (sessionId) => latest.current.retryTurn?.(sessionId) ?? false,
    note: (sessionId, message) => latest.current.queueWake?.(sessionId, message),
  });
  /** The chats the app runs whose own last turn failed; a delegated worker's stays its Lead's (selfRepair.ts). */
  const harnessFaults = (): HarnessFault[] => {
    const children = new Set((latest.current.tracker()?.known() ?? []).map((row) => row.childSession));
    const now = Date.now();
    const faults: HarnessFault[] = [];
    for (const entry of latest.current.sessionsRef.current) {
      if (children.has(entry.id)) continue;
      const fault = faultOf(entry, now);
      if (fault) faults.push(fault);
    }
    return faults;
  };
  // Harness care (harnessCare.ts): the app's own surroundings, from what it already holds and two reads of its own —
  // the build's database check (hourly; it copies the database, so not on every look) and the PR watches (every few
  // minutes). Every fix it makes is a Bot changes row; a fault it can't fix is a Needs-you row for the app, or one quiet
  // note in the chat it concerns.
  const WATCH_LOOK_MS = 5 * 60_000;
  const dbLook = useRef<{ at: number; health: DatabaseHealth | null } | null>(null);
  const watchLook = useRef<{ at: number; rows: readonly PrWatch[] | null } | null>(null);
  const trialSeen = useRef<number | null>(null);
  const databaseHealth = async (now: number): Promise<DatabaseHealth | null> => {
    if (!isTauri()) return null;
    const cached = dbLook.current;
    if (cached && now - cached.at < HOUR_MS) return cached.health;
    let health: DatabaseHealth | null = null;
    try {
      const raw = await invoke<DatabaseHealth>("db_health");
      if (raw && typeof raw.ok === "boolean") health = raw;
    } catch {
      // An older build has no such command, or the app is quitting: no finding, and no claim that it passed.
    }
    dbLook.current = { at: now, health };
    return health;
  };
  const liveWatches = async (now: number): Promise<readonly PrWatch[] | null> => {
    if (!isTauri()) return null;
    const cached = watchLook.current;
    if (cached && now - cached.at < WATCH_LOOK_MS) return cached.rows;
    let rows: readonly PrWatch[] | null = null;
    try {
      rows = await tauriPrWatches.list();
    } catch {
      rows = null;
    }
    watchLook.current = { at: now, rows };
    return rows;
  };
  const care = useRef<HarnessCare | null>(null);
  care.current ??= new HarnessCare({
    fix: async (fault) => {
      if (fault.fix === "pause-pr-watch" && fault.about?.watch) {
        await tauriPrWatches.remove({ ...fault.about.watch, reason: "stopped" });
        // The cached list still names it: the next look reads a fresh one.
        watchLook.current = null;
        return true;
      }
      if (fault.fix === "continue-chat" && fault.about?.session)
        return latest.current.retryTurn?.(fault.about.session) ?? false;
      if (fault.fix === "cancel-orphan" && fault.about?.delegation) {
        const tracker = latest.current.tracker();
        const row = tracker?.row(fault.about.delegation);
        if (!tracker || !row || row.state !== "running") return false;
        await tracker.cancelFollowed(row, "The session it was working in is gone.");
        return true;
      }
      return false;
    },
    fixed: (fault) => {
      if (!fault.fix) return;
      recordBotNote({
        id: `care-${fault.id}-${Date.now()}`,
        bot: "Self-repair",
        line: SAFE_FIXES[fault.fix],
        now: fault.line,
        after: SAFE_FIXES[fault.fix],
        system: true,
      });
    },
    tell: (fault) => {
      if (fault.kind === "resume" && fault.about?.session) {
        void latest.current.queueWake?.(fault.about.session, resumeStoppedNote(fault.about.session, Date.now()));
        return;
      }
      addHarnessIssue({ id: fault.id, kind: fault.kind, line: fault.line, ...(fault.path ? { path: fault.path } : {}) });
    },
    clear: (fault) => clearHarnessIssue(fault.id),
  });
  /** Read what care looks at, then let it act on what is due. */
  const careLook = async (): Promise<void> => {
    const now = Date.now();
    const ship = shipStatus();
    if (ship.enabled && ship.holding && ship.trial && !ship.trial.committed) trialSeen.current ??= now;
    else trialSeen.current = null;
    const [database, watches] = await Promise.all([databaseHealth(now), liveWatches(now)]);
    await care.current!.tick(
      careFaults({
        now,
        sessions: latest.current.sessionsRef.current,
        tracker: latest.current.tracker(),
        database,
        watches,
        ship,
        trialSeenAt: trialSeen.current,
      }),
    );
  };
  const watch = useRef<StallWatch | null>(null);
  watch.current ??= new StallWatch({
    hourly: (row) => repair.current!.stallFor(row),
    // r87 (s14 r86 run 3: a worker sat three minutes on "API Error: Server error" and nobody heard): its Lead is told.
    providerStall: (row, stall) => {
      // r88: the Lead's chat says it at once, from the app; the Lead's own line follows when it has woken.
      const line = providerStallChatLine(row, stall);
      latest.current.setSessions?.((previous) =>
        previous.map((chat) =>
          chat.id === row.ownerSession && !chat.blocks.some((block) => block.id === line.id) ? { ...chat, blocks: [...chat.blocks, line] } : chat,
        ),
      );
      void latest.current.queueWake?.(row.ownerSession, repairNoteMessage(row, providerStallNote(row, stall), Date.now()));
    },
    tracker: () => latest.current.tracker(),
    session,
    openOwned,
    // Hivra WP-11: a stall notice goes to the worker's first mate's wake queue, once per silent stretch.
    wake: (wake) => void currentWakeQueue()?.add(wake).catch((error: unknown) => console.error("Could not queue a first mate's wake", error)),
    // Hivra WP-11: twenty silent minutes, nothing pending: settle it failed (retryable; its report wakes its first mate),
    // then stop its turn, in that order, so the stop's own settle finds the row already closed.
    silent: (row, stop) => {
      const tracker = latest.current.tracker();
      if (!tracker) return;
      const result = {
        ...storedResult(row, session(row.childSession) as Session | undefined),
        status: "failed" as const,
        error: stop.error,
        // Not a provider class: self-repair never retries it, so its first mate decides (classifier.ts).
        errorClass: stop.errorClass as MonoSessionCompletionResult["errorClass"],
        retryable: true,
      };
      void tracker
        .settleFollowed(row, result, "watcher")
        .then((applied) => (applied ? latest.current.stopSession?.(row.childSession) : undefined))
        .catch((error: unknown) => console.error("Could not stop a silent worker", error));
    },
  });
  const main = useRef<boolean | null>(null);
  main.current ??= isMainWindow();
  // The same window announces them: one native banner per stuck worker its Lead can't handle by itself.
  useStuckNotifications({ sessionsRef: options.sessionsRef, enabled: main.current });

  const { sessions } = options;
  useEffect(() => {
    if (main.current) watch.current!.sync();
  }, [sessions]);

  useEffect(() => {
    if (!main.current) return;
    // The fake-Claude bench stalls in seconds: it looks twice per stall time.
    const bench = appIdentity()?.verify?.stallMs;
    const every = bench ? Math.max(1_000, Math.min(STALL_LOOK_MS, bench / 2)) : STALL_LOOK_MS;
    // WP-102: a sleeping Mac suspends this process while the wall clock runs on, so the first look after wake arrives
    // far later than its interval. That time is forgiven, never counted as a worker's silence (classifier.ts sleepGap).
    let lastLookAt = Date.now();
    const timer = setInterval(() => {
      const at = Date.now();
      const sleptMs = sleepGap(at - lastLookAt, every);
      lastLookAt = at;
      // Reading a folder can fail; one bad read must never stop the loop or the stall watcher.
      void hourly(HOUR_MS).catch(() => undefined);
      // Self-repair reads first (its gave-up line is what the stall watcher writes), then the stall watcher judges.
      void repair.current!.tick().finally(() => watch.current!.tick(sleptMs));
      // The chats' own failed turns: two automatic tries, then one plain line and no more.
      harness.current!.tick(harnessFaults());
      // The app's surroundings: what care can fix, it fixes; what it can't, it tells Ash once.
      void careLook().catch(() => undefined);
    }, every);
    return () => clearInterval(timer);
  }, []);
}
