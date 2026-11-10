import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createWorktree, removeWorktree } from "../../source-control/model/worktrees";
import { loadNewChatWorktree } from "../../settings/model/settings";
import type { Session } from "../model/session";
import {
  forkAttemptGate,
  forkChat,
  forkStillValid,
  forkWorktreeDefault,
  forkWorktreeError,
  type ForkAttemptGate,
  type ForkPort,
} from "../model/threadFork";
import { forkImagePort } from "../model/threadForkImages";
import {
  clearThreadForkAsk,
  subscribeThreadForkAsk,
  threadForkAskSnapshot,
} from "../model/threadForkAsk";
import { ThreadForkDialog } from "./ThreadForkDialog";

type Props = {
  sessionsRef: RefObject<Session[]>;
  onOpen: (session: Session) => void;
  /** Worktree creation and removal, and image copies. Tests pass a stub. The real calls are the app's own. */
  port?: ForkPort;
  /** Read once when the dialog opens. Defaults to the new-chat worktree setting. */
  setting?: () => unknown;
};

/**
 * WP-123: confirms a fork and opens the copy. The original session is only
 * read. A second click while one fork is in flight does nothing, and a cancel
 * stops it: whatever it had made (a worktree, image copies) is removed. If the
 * fork opened but something did not come along, the confirm stays to say so.
 */
export function ThreadForkHost({
  sessionsRef,
  onOpen,
  port,
  setting = loadNewChatWorktree,
}: Props) {
  const ask = useSyncExternalStore(
    subscribeThreadForkAsk,
    threadForkAskSnapshot,
    threadForkAskSnapshot,
  );
  const [error, setError] = useState<string | null>(null);
  /** Set when the fork is open and the confirm stays only to say what did not come along. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const busyRef = useRef(false);
  /** Token already opened, so a second click on the same confirm cannot fork again. */
  const finished = useRef<number | null>(null);
  const gate = useRef<ForkAttemptGate | null>(null);
  if (!gate.current) gate.current = forkAttemptGate();
  const worktreePort: ForkPort = port ?? {
    createWorktree,
    // Taking back a worktree that was just made for a fork nobody kept: it has no chats, so nothing is detached.
    removeWorktree: (cwd, path, force) => removeWorktree(cwd, path, force, true),
    ...forkImagePort,
  };

  useEffect(() => {
    setError(null);
    setNotice(null);
    busyRef.current = false;
    setBusy(false);
    if (!ask) return;
    setUseWorktree(forkWorktreeDefault(setting()));
    // The choice is fixed when the dialog opens. A later setting change must not
    // overwrite a box the person has already moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.token]);

  if (!ask) return null;
  const request = ask;

  const confirm = () => {
    if (busyRef.current || finished.current === request.token) return;
    busyRef.current = true;
    setBusy(true);
    const ticket = gate.current!.start();
    setError(null);
    const session = sessionsRef.current?.find((item) => item.id === request.sessionId);
    if (!gate.current!.current(ticket)) return;
    if (!session || !forkStillValid(session, request.blockId)) {
      busyRef.current = false;
      setBusy(false);
      setError(
        session
          ? "That message is no longer in this chat."
          : "This chat is no longer open.",
      );
      return;
    }
    const wanted = useWorktree;
    void (async () => {
      try {
        const said: { line: string | null } = { line: null };
        const fork = await forkChat(
          session,
          request.blockId,
          {
            useNewWorktree: wanted,
            readSource: () =>
              sessionsRef.current?.find((item) => item.id === request.sessionId),
            // A cancel or a newer attempt: forkChat stops and takes back what it made.
            cancelled: () => !gate.current!.current(ticket),
            onNotice: (line) => {
              said.line = line;
            },
          },
          worktreePort,
        );
        if (!gate.current!.current(ticket)) return;
        if (!fork) {
          setError("That message is no longer in this chat.");
          return;
        }
        finished.current = request.token;
        onOpen(fork);
        if (said.line) setNotice(said.line);
        else clearThreadForkAsk();
      } catch (err) {
        if (!gate.current!.current(ticket)) return;
        setError(forkWorktreeError(err));
      } finally {
        if (gate.current!.current(ticket)) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    })();
  };

  return (
    <ThreadForkDialog
      error={error}
      notice={notice}
      busy={busy}
      worktree={{ checked: useWorktree, onChange: setUseWorktree }}
      onFork={confirm}
      onCancel={() => {
        // Once the fork is open this only closes the note; there is nothing in flight to stop.
        gate.current?.cancel();
        busyRef.current = false;
        setBusy(false);
        clearThreadForkAsk();
      }}
    />
  );
}
