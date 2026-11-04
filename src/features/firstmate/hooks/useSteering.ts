// Hivra WP-14: delivers stored steering messages (src-tauri/src/steering.rs) into their workers' chats. It drains the
// store on start (so a message stored before a quit or crash still goes in), whenever a message is stored or settled,
// whenever a chat starts or ends a turn (a held message goes in when its worker is idle), and every 30 s while any are
// pending (a failed try is retried until the store gives up on it).
//
// Only the main window delivers (as useDelegations, useStallWatch and usePrWatches do): "New window" and the hidden
// quick-session windows load the same App and would otherwise read the same pending rows and submit them twice. Every
// window keeps the tools' host, so a task_message handled in another window still waits for main's delivery.
import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Session } from "../../sessions/model/session";
import {
  drainPending,
  RETRY_AFTER_MS,
  STEERING_CHANGED,
  tauriFirstMate,
  type DeliveryDeps,
  type FirstMateTasksHost,
  type SteerMessage,
} from "../model/steering";

/** Resolves once the message leaves plain pending (delivered, held or failed), or with it as it stands after `ms`. */
export function settledMessage(
  backend: DeliveryDeps["backend"],
  message: SteerMessage,
  ms: number,
  pollMs = 200,
): Promise<SteerMessage> {
  const until = Date.now() + ms;
  const look = async (): Promise<SteerMessage> => {
    const rows = await backend.list({ childSession: message.childSession, ownerSession: message.ownerSession });
    const now = rows.find((row) => row.id === message.id) ?? message;
    if (now.state !== "pending" || now.heldAt || Date.now() >= until) return now;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    return look();
  };
  return look();
}

/** True in the main window (and outside Tauri, where there is only one). */
export function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

/**
 * One drain at a time, rerun once if asked meanwhile. A window that doesn't deliver gets a drain that does nothing.
 */
export function steeringDrain(deps: () => DeliveryDeps, delivers: boolean): () => Promise<void> {
  if (!delivers) return () => Promise.resolve();
  let running: Promise<void> | null = null;
  let again = false;
  const run = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = drainPending(deps())
      .then(() => undefined)
      .catch((error) => console.warn("Steering delivery failed", error))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          void run();
        }
      });
    return running;
  };
  return run;
}

export function useSteering(
  sessions: readonly Pick<Session, "id" | "busy">[],
  deps: Omit<DeliveryDeps, "backend"> & { backend?: DeliveryDeps["backend"]; delivers?: boolean },
): FirstMateTasksHost {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const backend = deps.backend ?? tauriFirstMate;
  const delivers = useRef<boolean | null>(null);
  delivers.current ??= deps.delivers ?? isMainWindow();
  const drain = useMemo(
    () => steeringDrain(() => ({ ...depsRef.current, backend }), delivers.current!),
    [backend],
  );

  // On start, and every time a message is stored or settled.
  useEffect(() => {
    if (!delivers.current) return;
    void drain();
    let unlisten: (() => void) | undefined;
    let gone = false;
    void listen(STEERING_CHANGED, () => void drain())
      .then((stop) => (gone ? stop() : (unlisten = stop)))
      .catch(() => undefined);
    const timer = setInterval(() => void drain(), RETRY_AFTER_MS);
    return () => {
      gone = true;
      unlisten?.();
      clearInterval(timer);
    };
  }, [drain]);

  // A chat started or ended a turn: a held message may go in now.
  const busyKey = sessions
    .filter((session) => session.busy)
    .map((session) => session.id)
    .sort()
    .join(",");
  useEffect(() => {
    void drain();
  }, [busyKey, drain]);

  return useMemo(
    () => ({ backend, settled: (message: SteerMessage, ms: number) => settledMessage(backend, message, ms) }),
    [backend],
  );
}
