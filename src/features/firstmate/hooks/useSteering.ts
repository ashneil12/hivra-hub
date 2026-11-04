// Hivra WP-14: delivers stored steering messages (src-tauri/src/steering.rs) into their workers' chats. It drains the
// store on start (so a message stored before a quit or crash still goes in), whenever a message is stored or settled,
// whenever a chat starts or ends a turn (a held message goes in when its worker is idle), and every 30 s while any are
// pending (a failed try is retried until the store gives up on it).
import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
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

export function useSteering(
  sessions: readonly Pick<Session, "id" | "busy">[],
  deps: Omit<DeliveryDeps, "backend"> & { backend?: DeliveryDeps["backend"] },
): FirstMateTasksHost {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const backend = deps.backend ?? tauriFirstMate;
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const drain = useMemo(() => {
    const run = (): Promise<void> => {
      if (running.current) {
        again.current = true;
        return running.current;
      }
      running.current = drainPending({ ...depsRef.current, backend })
        .then(() => undefined)
        .catch((error) => console.warn("Steering delivery failed", error))
        .finally(() => {
          running.current = null;
          if (again.current) {
            again.current = false;
            void run();
          }
        });
      return running.current;
    };
    return run;
  }, [backend]);

  // On start, and every time a message is stored or settled.
  useEffect(() => {
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
