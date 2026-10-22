// Runs the stall watcher (model/workerStall.ts) in the main window, where the workers' turns run: every change to the
// chats is noted (a stalled worker that moves again is cleared at once), and every half minute the running rows are
// judged, so a stalled worker shows everywhere within about a minute of crossing its limit. The same look sends the
// hourly progress check (model/hourlyCheck.ts, board H2): one line to the owner of a worker running over an hour, with
// the evidence the app read itself (model/progressCheck.ts) — commits, changed files, passing and failing test runs, or
// plainly that nothing moved. Self-repair (model/selfRepair.ts, board H3) retries a crashed or hung worker with backoff
// before its Lead is told. The same window announces stuck workers with a native banner (useStuckNotifications), except a
// Lead's own stalled or crashed workers: their Lead handles those, and tells Ash in its own chat when only he can help.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { isOpenDelegation, type DelegationTracker } from "../model/delegations";
import { StallWatch } from "../model/workerStall";
import { HOUR_MS, hourlyCheckMessage, hourlyChecksDue } from "../model/hourlyCheck";
import { evidenceOf, evidenceSince, tallyTranscript, type FolderLook, type Look } from "../model/progressCheck";
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
        hourlyCheckMessage(row, now, { evidence, windowMinutes: Math.round((now - since) / 60_000) }),
      );
    }
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
  const watch = useRef<StallWatch | null>(null);
  watch.current ??= new StallWatch({
    hourly: (row) => repair.current!.stallFor(row),
    tracker: () => latest.current.tracker(),
    session,
    openOwned,
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
    const timer = setInterval(() => {
      // Reading a folder can fail; one bad read must never stop the loop or the stall watcher.
      void hourly(HOUR_MS).catch(() => undefined);
      // Self-repair reads first (its gave-up line is what the stall watcher writes), then the stall watcher judges.
      void repair.current!.tick().finally(() => watch.current!.tick());
      // The chats' own failed turns: two automatic tries, then one plain line and no more.
      harness.current!.tick(harnessFaults());
    }, every);
    return () => clearInterval(timer);
  }, []);
}
