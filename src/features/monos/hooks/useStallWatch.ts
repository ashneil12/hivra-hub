// Runs the stall watcher (model/workerStall.ts) in the main window, where the workers' turns run: every change to the
// chats is noted (a stalled worker that moves again is cleared at once), and every half minute the running rows are
// judged, so a stalled worker shows everywhere within about a minute of crossing its limit. The same look runs the
// hourly progress check and self-repair (model/workerProgress.ts, board H2): its stuck verdict is written on the row by
// the stall watcher, so it shows wherever a stall does. The same window announces stuck workers with a native banner
// (useStuckNotifications), except a Lead's own stalled or crashed workers: their Lead handles those, and tells Ash in
// its own chat when only he can help.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation, type DelegationTracker } from "../model/delegations";
import { StallWatch } from "../model/workerStall";
import { ProgressCheck, progressNoteMessage, type FolderLook } from "../model/workerProgress";
import { sendToChat } from "../../hub/model/waitingChats";
import { gitDiffStats, gitHistory } from "../../../platform/tauri/fs";
import { dismissQueuedMonoSessionCompletion, type MonoSessionCompletionBatches } from "../model/monoSessionCompletion";
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

/** A worker's folder for the hourly check: commits since `since` and its uncommitted changes. Null when unreadable. */
export async function readFolder(cwd: string, since: number): Promise<FolderLook | null> {
  if (!cwd) return null;
  try {
    const [history, diff] = await Promise.all([gitHistory(cwd, 100), gitDiffStats(cwd)]);
    return { commits: history.commits.filter((commit) => commit.timestamp * 1000 >= since).length, diff };
  } catch {
    return null;
  }
}

export function useStallWatch(options: {
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  tracker: () => DelegationTracker | null;
  /** The app's hands for the hourly check (useDelegationTree passes its own options through). */
  queueWake?: (owner: string, message: QueuedMessage) => Promise<void> | void;
  stopSession?: (sessionId: string, managed?: boolean) => Promise<unknown> | void;
  batches?: () => MonoSessionCompletionBatches | null;
  setSessions?: Dispatch<SetStateAction<Session[]>>;
}): void {
  const latest = useRef(options);
  latest.current = options;
  const openOwned = (chat: string) =>
    latest.current
      .tracker()
      ?.known()
      .filter((row) => row.ownerSession === chat && isOpenDelegation(row)).length ?? 0;
  const session = (id: string) => latest.current.sessionsRef.current.find((entry) => entry.id === id);
  const progress = useRef<ProgressCheck | null>(null);
  progress.current ??= new ProgressCheck({
    tracker: () => latest.current.tracker(),
    session,
    openOwned,
    folder: readFolder,
    tellLead: (row: Delegation, text: string) => latest.current.queueWake?.(row.ownerSession, progressNoteMessage(row, text, Date.now())),
    message: (row: Delegation, text: string) => sendToChat(row.childSession, text),
    stopTurn: async (row: Delegation) => {
      await latest.current.stopSession?.(row.childSession);
      return true;
    },
    dropReport: (row: Delegation) => {
      latest.current.batches?.()?.dismissSession(row.ownerSession, row.childSession);
      latest.current.setSessions?.((previous) =>
        previous.map((entry) =>
          entry.id === row.ownerSession ? dismissQueuedMonoSessionCompletion(entry, row.childSession) : entry,
        ),
      );
    },
  });
  const watch = useRef<StallWatch | null>(null);
  watch.current ??= new StallWatch({
    hourly: (row) => progress.current!.stallFor(row),
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
    // The hourly check reads first (its verdict is what the stall watcher writes), then the stall watcher judges.
    const timer = setInterval(() => {
      void progress.current!.tick().finally(() => watch.current!.tick());
    }, every);
    return () => clearInterval(timer);
  }, []);
}
