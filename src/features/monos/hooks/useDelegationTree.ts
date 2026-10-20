// The app's one hook for the delegation tree (docs/PHASE-2-DESIGN.md H4): workers' questions routed to their Lead
// (model/delegationQuestions.ts), one Stop for everything beneath a chat (model/stopTree.ts), and the rows and hands
// the tree's UI reads (model/delegationStore.ts). App.tsx calls it once, next to its own Stop.
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { dequeueQueuedMessage } from "../../sessions/model/messageQueue";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import {
  isQuestionWakeFor,
  QuestionRouter,
  TaskWaits,
} from "../model/delegationQuestions";
import {
  delegationRows,
  noteStopFailures,
  setDelegationActions,
} from "../model/delegationStore";
import {
  tauriDelegations,
  type Delegation,
  type DelegationsBackend,
  type DelegationTracker,
} from "../model/delegations";
import { isMonoSession, monoForSession } from "../model/mono";
import {
  dismissQueuedMonoSessionCompletion,
  type MonoSessionCompletionBatches,
} from "../model/monoSessionCompletion";
import {
  hasWorkBeneath,
  stopTask,
  stopTree,
  type StopTreeHost,
  type StopTreeResult,
} from "../model/stopTree";
import { useDelegationFeed } from "./useDelegationFeed";

/** What Ash's own Stop records on the rows it cancels. */
export const ASH_STOP_REASON = "Stopped by Ash.";

export type DelegationTree = {
  waits: TaskWaits;
  questions: QuestionRouter;
  /** Stop a chat and everything beneath it, as `by`. */
  stopTree(chat: string, reason: string, by: string): Promise<StopTreeResult>;
  /** Stop one task and everything beneath it, as `by`. */
  stopTask(
    row: Delegation,
    reason: string,
    by: string,
  ): Promise<StopTreeResult>;
  /** Ash's Stop on a chat: a Mono with work out stops with everything beneath it; any other chat as before. */
  stopFromUser(sessionId: string, managed?: boolean): Promise<unknown> | void;
};

export function useDelegationTree(options: {
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  tracker: () => DelegationTracker | null;
  batches: () => MonoSessionCompletionBatches | null;
  /** Put a hidden turn in a Mono's queue (queueMonoSessionCompletion). */
  queueWake: (owner: string, message: QueuedMessage) => Promise<void> | void;
  /** The app's own per-session Stop (never the cascade). */
  stopSession: (
    sessionId: string,
    managed?: boolean,
  ) => Promise<unknown> | void;
  openMono: (monoId: string) => Promise<void>;
  /** The Mono view's chat, once a Mono is open. */
  monoView: () => string | null;
  showLaunched: (monoSessionId: string, childSession: string) => Promise<void>;
  openSession: (sessionId: string) => Promise<unknown>;
  backend?: DelegationsBackend;
}): DelegationTree {
  const latest = useRef(options);
  latest.current = options;
  const backend = options.backend ?? tauriDelegations;

  const waits = useRef<TaskWaits | null>(null);
  waits.current ??= new TaskWaits();
  const questions = useRef<QuestionRouter | null>(null);
  questions.current ??= new QuestionRouter({
    tracker: () => latest.current.tracker(),
    session: (id) =>
      latest.current.sessionsRef.current.find((session) => session.id === id),
    isMono: isMonoSession,
    queueWake: (owner, message) => latest.current.queueWake(owner, message),
    withdrawWake: (owner, id) =>
      latest.current.setSessions((previous) =>
        previous.map((session) =>
          session.id === owner &&
          session.queuedMessages?.some((message) => message.id === id)
            ? dequeueQueuedMessage(session, id)
            : session,
        ),
      ),
    waits: waits.current,
  });

  // Every change to the chats: a new question goes to its Lead, an answered one is withdrawn.
  const { sessions } = options;
  useEffect(() => {
    questions.current!.sync(sessions);
  }, [sessions]);

  useDelegationFeed(backend);

  const host = useRef<StopTreeHost | null>(null);
  host.current ??= {
    listOpen: () => backend.listOpen(),
    tree: (id) => backend.tree(id),
    cancel: (owner, rows, reason, by) => {
      const tracker = latest.current.tracker();
      return tracker
        ? tracker.cancelOwned(owner, rows, reason, by)
        : backend.cancel(
            rows.map((row) => row.id),
            reason,
            by,
          );
    },
    busy: (id) =>
      !!latest.current.sessionsRef.current.find((session) => session.id === id)
        ?.busy,
    stop: async (id) => {
      await latest.current.stopSession(id);
    },
    // The owner doesn't need this child's report or question any more: out of the batch cache and its queue.
    dropReport: (owner, child) => {
      latest.current.batches()?.dismissSession(owner, child);
      flushSync(() =>
        latest.current.setSessions((previous) =>
          previous.map((session) => {
            if (session.id !== owner) return session;
            let next = dismissQueuedMonoSessionCompletion(session, child);
            for (const message of next.queuedMessages ?? [])
              if (isQuestionWakeFor(message, child))
                next = dequeueQueuedMessage(next, message.id);
            return next;
          }),
        ),
      );
    },
  };

  const treeStop = useCallback(
    (chat: string, reason: string, by: string) =>
      stopTree(chat, host.current!, { reason, by }),
    [],
  );
  const taskStop = useCallback(
    (row: Delegation, reason: string, by: string) =>
      stopTask(row, host.current!, { reason, by }),
    [],
  );
  const stopFromUser = useCallback(
    (sessionId: string, managed = false) => {
      if (
        managed ||
        !isMonoSession(sessionId) ||
        !hasWorkBeneath(sessionId, delegationRows())
      )
        return latest.current.stopSession(sessionId, managed);
      return treeStop(sessionId, ASH_STOP_REASON, "user").then((result) => {
        noteStopFailures(sessionId, result.stopFailed);
        return result;
      });
    },
    [treeStop],
  );

  // The tree's controls in the UI: open the Lead or a child chat, stop a Lead's tree or one task.
  useEffect(
    () =>
      setDelegationActions({
        openOwner: (ownerSession) => {
          const mono = monoForSession(ownerSession);
          if (mono) void latest.current.openMono(mono.id);
          else
            void Promise.resolve(
              latest.current.openSession(ownerSession),
            ).catch(() => undefined);
        },
        openChild: (ownerSession, childSession) => {
          const mono = monoForSession(ownerSession);
          if (!mono) {
            void Promise.resolve(
              latest.current.openSession(childSession),
            ).catch(() => undefined);
            return;
          }
          void latest.current.openMono(mono.id).then(() => {
            const view = latest.current.monoView();
            if (view === ownerSession)
              void latest.current.showLaunched(view, childSession);
          });
        },
        stopTree: (chat) =>
          treeStop(chat, ASH_STOP_REASON, "user").then((result) => {
            noteStopFailures(chat, result.stopFailed);
            return result;
          }),
        stopRow: (row) => taskStop(row, ASH_STOP_REASON, "user"),
      }),
    [treeStop, taskStop],
  );

  return {
    waits: waits.current,
    questions: questions.current,
    stopTree: treeStop,
    stopTask: taskStop,
    stopFromUser,
  };
}
