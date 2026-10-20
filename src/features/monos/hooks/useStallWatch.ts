// Runs the stall watcher (model/workerStall.ts) in the main window, where the workers' turns run: every change to the
// chats is noted (a stalled worker that moves again is cleared at once), and every half minute the running rows are
// judged, so a stalled worker shows everywhere within about a minute of crossing its limit. The same window announces
// stuck workers with a native banner (useStuckNotifications).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, type MutableRefObject } from "react";
import type { Session } from "../../sessions/model/session";
import { isOpenDelegation, type DelegationTracker } from "../model/delegations";
import { StallWatch } from "../model/workerStall";
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
}): void {
  const latest = useRef(options);
  latest.current = options;
  const watch = useRef<StallWatch | null>(null);
  watch.current ??= new StallWatch({
    tracker: () => latest.current.tracker(),
    session: (id) => latest.current.sessionsRef.current.find((session) => session.id === id),
    openOwned: (chat) =>
      latest.current
        .tracker()
        ?.known()
        .filter((row) => row.ownerSession === chat && isOpenDelegation(row)).length ?? 0,
  });
  const main = useRef<boolean | null>(null);
  main.current ??= isMainWindow();
  // The same window announces them: one native banner per worker that fails or stalls.
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
    const timer = setInterval(() => watch.current!.tick(), every);
    return () => clearInterval(timer);
  }, []);
}
