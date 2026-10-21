// Runs the stall watcher (model/workerStall.ts) in the main window, where the workers' turns run: every change to the
// chats is noted (a stalled worker that moves again is cleared at once), and every half minute the running rows are
// judged, so a stalled worker shows everywhere within about a minute of crossing its limit. The same look sends the
// hourly progress check (model/hourlyCheck.ts): one line to the owner of a worker running over an hour, and self-repair
// (model/selfRepair.ts, board H3): a crashed or hung worker is retried with backoff before its Lead is told. The same window
// announces stuck workers with a native banner (useStuckNotifications), except a Lead's own stalled or crashed
// workers: their Lead handles those, and tells Ash in its own chat when only he can help.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { isOpenDelegation, type DelegationTracker } from "../model/delegations";
import { StallWatch } from "../model/workerStall";
import { HOUR_MS, hourlyCheckMessage, hourlyChecksDue } from "../model/hourlyCheck";
import { repairNoteMessage, SelfRepair } from "../model/selfRepair";
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
  const hourly = (every: number) => {
    const rows = latest.current.tracker()?.known() ?? [];
    const now = Date.now();
    for (const id of hourlyChecksDue(rows, asked.current, now, every)) {
      const row = rows.find((entry) => entry.id === id)!;
      if (!asked.current.has(id) && now - born.current < every) continue;
      asked.current.set(id, now);
      void latest.current.queueWake?.(row.ownerSession, hourlyCheckMessage(row, now));
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
      hourly(HOUR_MS);
      // Self-repair reads first (its gave-up line is what the stall watcher writes), then the stall watcher judges.
      void repair.current!.tick().finally(() => watch.current!.tick());
    }, every);
    return () => clearInterval(timer);
  }, []);
}
