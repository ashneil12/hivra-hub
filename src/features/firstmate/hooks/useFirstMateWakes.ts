// Hivra WP-11: the app's one hook for the first mate's wake queue (watcher/wakeQueue.ts). The main window delivers:
// at start (a restart is a non-event: what was owed is drained), whenever Rust stores a wake, and on the watcher's
// half-minute look, which also fires due timers.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { getSession } from "../../sessions/data/sessionStore";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { isOrchestratorChat } from "../../monos/model/orchestrators";
import { FIRSTMATE_WAKE, setCurrentWakeQueue, tauriWakeQueue, WakeQueue, type WakeQueueBackend } from "../watcher/wakeQueue";

/** How often the main window looks (timers, and owners skipped last round). */
export const WAKE_LOOK_MS = 30_000;

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

export function useFirstMateWakes(options: {
  sessionsRef: MutableRefObject<Session[]>;
  /** Put a turn in a first mate's queue (queueMonoSessionCompletion). */
  queueWake: (ownerId: string, message: QueuedMessage) => Promise<void>;
  backend?: WakeQueueBackend;
}): WakeQueue {
  const latest = useRef(options);
  latest.current = options;
  const [queue] = useState(
    () =>
      new WakeQueue(options.backend ?? tauriWakeQueue, {
        isFirstMate: isOrchestratorChat,
        load: async (id) => latest.current.sessionsRef.current.find((session) => session.id === id) ?? (await getSession(id)),
        queueWake: (ownerId, message) => latest.current.queueWake(ownerId, message),
      }),
  );
  setCurrentWakeQueue(queue);

  useEffect(() => {
    if (!isMainWindow()) return;
    let live = true;
    const deliver = () => {
      if (!live) return;
      void queue.deliver().catch((error: unknown) => console.error("Could not deliver a first mate's wake", error));
    };
    const look = () => {
      if (!live) return;
      void queue
        .tick()
        .catch(() => 0)
        .finally(deliver);
    };
    look();
    const timer = setInterval(look, WAKE_LOOK_MS);
    const off = listen(FIRSTMATE_WAKE, deliver);
    return () => {
      live = false;
      clearInterval(timer);
      void off.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [queue]);

  return queue;
}
