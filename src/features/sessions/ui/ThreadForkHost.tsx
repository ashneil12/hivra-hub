import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { Session } from "../model/session";
import {
  forkAttemptGate,
  forkSessionAtMessage,
  type ForkAttemptGate,
} from "../model/threadFork";
import {
  clearThreadForkAsk,
  subscribeThreadForkAsk,
  threadForkAskSnapshot,
} from "../model/threadForkAsk";
import { ThreadForkDialog } from "./ThreadForkDialog";

type Props = {
  sessionsRef: RefObject<Session[]>;
  onOpen: (session: Session) => void;
};

/**
 * WP-123: confirms a fork and opens the copy. The original session is only
 * read. A second click while one fork is in flight does nothing.
 */
export function ThreadForkHost({ sessionsRef, onOpen }: Props) {
  const ask = useSyncExternalStore(
    subscribeThreadForkAsk,
    threadForkAskSnapshot,
    threadForkAskSnapshot,
  );
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  /** Token already opened, so a second click on the same confirm cannot fork again. */
  const finished = useRef<number | null>(null);
  const gate = useRef<ForkAttemptGate | null>(null);
  if (!gate.current) gate.current = forkAttemptGate();

  useEffect(() => {
    setError(null);
    busy.current = false;
  }, [ask?.token]);

  if (!ask) return null;
  const request = ask;

  const confirm = () => {
    if (busy.current || finished.current === request.token) return;
    busy.current = true;
    const ticket = gate.current!.start();
    setError(null);
    const session = sessionsRef.current?.find((item) => item.id === request.sessionId);
    if (!gate.current!.current(ticket)) return;
    if (!session) {
      busy.current = false;
      setError("This chat is no longer open.");
      return;
    }
    const fork = forkSessionAtMessage(session, request.blockId);
    if (!gate.current!.current(ticket)) return;
    if (!fork) {
      busy.current = false;
      setError("That message is no longer in this chat.");
      return;
    }
    finished.current = request.token;
    onOpen(fork);
    busy.current = false;
    clearThreadForkAsk();
  };

  return (
    <ThreadForkDialog
      error={error}
      onFork={confirm}
      onCancel={() => {
        gate.current?.cancel();
        busy.current = false;
        clearThreadForkAsk();
      }}
    />
  );
}
