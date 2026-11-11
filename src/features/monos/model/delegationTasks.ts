// The app's side of the delegate tool's task actions (agent-app/model/agentAppTasks.ts) on the delegation rows (H2):
// reads go to the store by owner, moves go through the tracker so this window's cache stays in step, and the report a
// Mono no longer needs (a result it read, a task it cancelled) leaves its in-memory batch and its queue. H4: a cancel
// stops the whole tree beneath the task (stopTree.ts), a wait marks the chat as waiting (so its workers' questions come
// back through the wait, not a wake), and an answer is noted for the question router before it reaches the worker.
import type { AgentAppTasksHost } from "../../agent-app/model/agentAppTasks";
import type { FanoutCheckpointStore } from "../../firstmate/host/fanoutCheckpointStore";
import { backendFrom, cancelHeld, heldWaiting, reviewBeforeCrew } from "../../fresh-eyes/model/gate";
import { decideGateVerdict, saveGatePlan } from "../../firstmate/model/completionGates";
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
  /** Take a followed brief back out of its chat's queue, if it still waits there (followedBriefs.ts). */
  unqueue?(childSession: string, requestId: string): void;
  /** A Mono briefs a project's Lead (App.tsx, through leadershipDelegation.ts). */
  briefLead?: AgentAppTasksHost["briefLead"];
  /** Whether the Lead a brief names exists, asked before a fresh-eyes review. */
  checkLead?: AgentAppTasksHost["checkLead"];
  /** WP-141: the lock and Never use list in force (crew/model/host.ts crewPolicyInForce). */
  crewPolicy?: AgentAppTasksHost["crewPolicy"];
  /** WP-141: the gate every worker and session launch passes before its process starts (crew_launch_check). */
  crewGate?: AgentAppTasksHost["crewGate"];
  crewAnyLock?: AgentAppTasksHost["crewAnyLock"];
  /** Where a Mono's work goes: its project's coding team, or its own team (hub/model/monoTeams.ts). */
  monoWork?: AgentAppTasksHost["monoWork"];
  /** Workers per project and the ones waiting for a free worker (H8, workerPool.ts). */
  pool?: AgentAppTasksHost["pool"];
  /** WP-13: which CLI, model and effort a delegated task uses. */
  crewRoute?: AgentAppTasksHost["crewRoute"];
  /** WP-141: tasks.pick's crew pick and the Leads a Mono may brief. */
  crewPick?: AgentAppTasksHost["crewPick"];
  pickMonos?: AgentAppTasksHost["pickMonos"];
  /** Hivra WP-14: steering messages and decisions (firstmate/hooks/useSteering.ts). */
  firstMate?: AgentAppTasksHost["firstMate"];
  /** Hivra WP-172: a fan-out's checkpoint, so a plan cut short can be resumed (fanoutCheckpointStore.ts). */
  fanoutCheckpoints?: FanoutCheckpointStore;
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
    teamOpen: () => deps.backend.listOpen(),
    acknowledge: async (owner, rows) => {
      await tracker().acknowledge(
        owner,
        rows.map((row) => row.id),
      );
      for (const row of rows) deps.dropReport(owner, row.childSession);
    },
    nextChange: deps.nextChange ?? nextDelegationChange,
    redo: async (owner, row, task) => {
      await tracker().noteRedo(owner, row, task);
      // r84 (s14 blind): a job held for Ash's answer that the Lead carries on in a new job is over, not Working for ever.
      if (row.state === "question") await tracker().cancelOwned(owner, [row], "Carried on by a new job with Ash's answer.");
    },
    cancel: async (owner, row, reason) => {
      // The cascade (H4) takes a followed brief out of its chat's queue and never stops that chat for it.
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
      // A followed brief went to a chat that has other work (a Lead's own chat, a busy session): it is taken out of
      // the queue if it still waits there, and that chat is never stopped for it.
      if (row.follow) {
        deps.unqueue?.(row.childSession, row.requestId);
        return { stopFailed };
      }
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
    // A worker's own word about the task it is doing (task_cannot with no taskId): its newest running row.
    selfTask: async (session) => {
      const rows = await deps.backend.listOpen();
      return rows
        .filter((row) => row.childSession === session && row.state === "running")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
    },
    ...(deps.firstMate ? { firstMate: deps.firstMate } : {}),
    // Hivra WP-172: a fan-out writes its plan here as it sends, and a resume reads it back.
    ...(deps.fanoutCheckpoints ? { fanoutCheckpoints: deps.fanoutCheckpoints } : {}),
    // Hivra WP-10: the depth cap, checked by the store before anything starts.
    ...(deps.backend.checkDepth
      ? { checkDepth: (owner: string, opts?: { fanout?: boolean }) => deps.backend.checkDepth!(owner, opts) }
      : {}),
    // Declared, not judged (workerStall.ts never overwrites it): the row is Ash's until it moves.
    cannot: async (by, row, reason) => {
      const change = await tracker().setStall(
        row,
        { kind: "blocked", reason, since: (deps.now ?? Date.now)() },
        by,
      );
      const after = change.row ?? row;
      return after.state === "running" && after.stallKind === "blocked";
    },
    child: (id) => {
      const session = deps.session(id);
      if (!session) return undefined;
      return {
        busy: session.busy,
        pendingQuestion: session.pendingQuestion,
        ...(session.busy ? { lastActiveAt: (deps.now ?? Date.now)() } : {}),
      };
    },
    ...(deps.briefLead ? { briefLead: deps.briefLead } : {}),
    ...(deps.checkLead ? { checkLead: deps.checkLead } : {}),
    ...(deps.crewPolicy ? { crewPolicy: deps.crewPolicy } : {}),
    ...(deps.crewGate ? { crewGate: deps.crewGate } : {}),
    ...(deps.crewAnyLock ? { crewAnyLock: deps.crewAnyLock } : {}),
    ...(deps.monoWork ? { monoWork: deps.monoWork } : {}),
    ...(deps.pool ? { pool: deps.pool } : {}),
    ...(deps.crewRoute ? { crewRoute: deps.crewRoute } : {}),
    ...(deps.crewPick ? { crewPick: deps.crewPick } : {}),
    ...(deps.pickMonos ? { pickMonos: deps.pickMonos } : {}),
    // WP-144: off unless this project turned fresh-eyes review on. Reviewers run after this call returns (control.rs cuts
    // the app call at 35 s). The Inbox and the chat that asked come from the first mate's own backend.
    freshEyes: (input) =>
      reviewBeforeCrew(input, { ...(deps.firstMate ? { backend: backendFrom(deps.firstMate.backend) } : {}) }),
    // WP-144: a held brief is a waiting task: task_status lists it and task_cancel takes it back.
    freshEyesWaiting: (owner) => heldWaiting(owner),
    freshEyesCancel: (owner, childSessionId) =>
      cancelHeld(owner, childSessionId, { ...(deps.firstMate ? { backend: backendFrom(deps.firstMate.backend) } : {}) }),
    // WP-40: the brief's gates stay with the task, and its first mate accepts an unsure one.
    saveGates: (id, request, folder) => saveGatePlan(id, request, folder),
    decideGates: (owner, id, accept, reason) => decideGateVerdict(owner, id, accept, reason),
    ...(deps.hubProjectId ? { hubProjectId: deps.hubProjectId } : {}),
    ...(deps.hubProjectFolder ? { hubProjectFolder: deps.hubProjectFolder } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
}
