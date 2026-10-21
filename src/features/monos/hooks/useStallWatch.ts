// Runs the stall watcher (model/workerStall.ts) in the main window, where the workers' turns run: every change to the
// chats is noted (a stalled worker that moves again is cleared at once), and every half minute the running rows are
// judged, so a stalled worker shows everywhere within about a minute of crossing its limit. The same look sends the
// hourly progress check (model/hourlyCheck.ts): one line to the owner of a worker running over an hour. The same window
// announces stuck workers with a native banner (useStuckNotifications), except a Lead's own stalled or crashed
// workers: their Lead handles those, and tells Ash in its own chat when only he can help.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, type MutableRefObject } from "react";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { isOpenDelegation, type DelegationTracker } from "../model/delegations";
import { StallWatch } from "../model/workerStall";
import { HOUR_MS, hourlyCheckMessage, hourlyChecksDue } from "../model/hourlyCheck";
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
  const watch = useRef<StallWatch | null>(null);
  watch.current ??= new StallWatch({
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
      watch.current!.tick();
    }, every);
    return () => clearInterval(timer);
  }, []);
}
