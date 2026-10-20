// The app's side of the delegate tool's task actions (agent-app/model/agentAppTasks.ts) on the delegation rows (H2):
// reads go to the store by owner, moves go through the tracker so this window's cache stays in step, and the report a
// Mono no longer needs (a result it read, a task it cancelled) leaves its in-memory batch and its queue. H4: a cancel
// stops the whole tree beneath the task (stopTree.ts), a wait marks the chat as waiting (so its workers' questions come
// back through the wait, not a wake), and an answer is noted for the question router before it reaches the worker.
import type { AgentAppTasksHost } from "../../agent-app/model/agentAppTasks";
import type { Session } from "../../sessions/model/session";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";
import type { QuestionRouter, TaskWaits } from "./delegationQuestions";
import {
  isOpenDelegation,
  nextDelegationChange,
  type Delegation,
  type DelegationTracker,
  type DelegationsBackend,
} from "./delegations";
import type { StopTreeResult } from "./stopTree";

export type DelegationTasksDeps = {
  backend: DelegationsBackend;
  tracker(): DelegationTracker | null;
  /** A session as this window has it. */
  session(id: string): Session | undefined;
  /** Stop a running child's turn (the user's own Stop). */
  stop(id: string): Promise<void>;
  /** The owner doesn't need this child's report any more: drop it from the batch cache and the owner's queue. */
  dropReport(ownerId: string, childSession: string): void;
  /** Hand a worker's question its answer (respondHarnessQuestion). */
  respond?(child: Session, requestId: number, reply: UserQuestionReply): void;
  /** Stop a task and everything beneath it (stopTree.ts `stopTask`); without it only the task's own worker stops. */
  stopTask?(row: Delegation, reason: string, by: string): Promise<StopTreeResult>;
  /** Which chats sit in task_wait (delegationQuestions.ts). */
  waits?: TaskWaits;
  /** The question router, told who answered before the answer goes out. */
  questions?: QuestionRouter;
  hubProjectId?(folder: string): string | undefined;
  hubProjectFolder?(id: string): string | undefined;
  nextChange?(ms: number): Promise<void>;
  now?(): number;
};

export function delegationTasksHost(deps: DelegationTasksDeps): AgentAppTasksHost {
  const tracker = () => {
    const current = deps.tracker();
    if (!current) throw new Error("Delegations are still loading; try again in a moment");
    return current;
  };
  return {
    owned: (owner, query) => deps.backend.owned({ ownerSession: owner, ...query }),
    tree: (id) => deps.backend.tree(id),
    acknowledge: async (owner, rows) => {
      await tracker().acknowledge(
        owner,
        rows.map((row) => row.id),
      );
      for (const row of rows) deps.dropReport(owner, row.childSession);
    },
    nextChange: deps.nextChange ?? nextDelegationChange,
    cancel: async (owner, row, reason) => {
      if (deps.stopTask) {
        const result = await deps.stopTask(row, reason, `owner:${owner}`);
        return {
          stopFailed: result.stopFailed,
          stopped: result.stopped,
          cancelled: result.cancelled,
        };
      }
      // The row first, so it keeps this reason rather than the one a plain Stop gives.
      await tracker().cancelOwned(owner, [row], reason);
      const stopFailed: string[] = [];
      const child = deps.session(row.childSession);
      if (isOpenDelegation(row) && child?.busy) {
        try {
          await deps.stop(row.childSession);
        } catch {
          stopFailed.push(row.childSession);
        }
      }
      deps.dropReport(owner, row.childSession);
      return { stopFailed };
    },
    ...(deps.waits
      ? { waiting: (owner: string, on: boolean) => deps.waits!.set(owner, on) }
      : {}),
    ...(deps.respond
      ? {
          answer: async (owner, row, requestId, reply) => {
            const child = deps.session(row.childSession);
            if (!child || child.pendingQuestion?.requestId !== requestId)
              throw new Error("That question is no longer open; read the task again with task_status.");
            const by = `owner:${owner}`;
            const detail = {
              requestId,
              ...(reply.kind === "answered" ? { answers: reply.answers } : { skipped: true }),
            };
            // The first answer wins and is logged on the row, with who gave it and what it was.
            deps.questions?.noteAnswer(row.childSession, requestId, by, reply);
            deps.respond!(child, requestId, reply);
            const tracker = deps.tracker();
            if (tracker) await tracker.setQuestion(row, null, by, detail);
            else await deps.backend.setQuestion(row.id, null, by, detail);
          },
        }
      : {}),
    child: (id) => {
      const session = deps.session(id);
      if (!session) return undefined;
      return {
        busy: session.busy,
        pendingQuestion: session.pendingQuestion,
        ...(session.busy ? { lastActiveAt: (deps.now ?? Date.now)() } : {}),
      };
    },
    ...(deps.hubProjectId ? { hubProjectId: deps.hubProjectId } : {}),
    ...(deps.hubProjectFolder ? { hubProjectFolder: deps.hubProjectFolder } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
}
