import { TurnNotReadyError } from "../../core/types";
import { credentialBlock } from "../../core/credentialGuard";
import {
  claudeAppend,
  claudeAppendArgs,
  claudeExtraArgs,
  claudePluginLaunch,
  clearNotedAppends,
  mergeClaudeAppend,
  notedSessionAppend,
  noteSessionAppend,
} from "./claudeExtraArgs";
import { nativeModelId, resolveModel } from "../../../../features/sessions/model/models";
import { customModelRoute, effortDroppedNotice, modelKeyStore, pickedCustomEffort } from "../../../../features/sessions/model/customModels";
import { reviewReportedTurn } from "../../../../features/usage/model/spendGate";
import { sameProviderAccountId } from "../../../../features/providers/model/providerAccounts";
import type {
  CutWork,
  RuntimeMode,
  SessionGoal,
  TaskListItem,
  TaskListMeta,
} from "../../../../features/sessions/model/session";
import { loadClaudeHooks } from "../../../../features/settings/model/settings";
import {
  execChild,
  killChild,
  resolveClaudeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
  writeChild,
} from "../../core/child";
import {
  askUserQuestionAllowInput,
  asRecord,
  assistantMessageId,
  assistantTextBlocks,
  assistantThinkingBlocks,
  assistantToolUses,
  contextFromResult,
  contextUsedFromAssistant,
  turnMetricsFromResult,
  buildClaudeSpawnArgs,
  buildClaudeUserMessage,
  buildControlRequest,
  buildControlResponse,
  cutWorkKind,
  deadConversationFromResult,
  extractAskUserQuestionTitle,
  extractExitPlanModePlan,
  inputJsonDeltaFromEvent,
  isAgentTaskType,
  isClaudeUltracodeEffort,
  isReplayedTaskNotificationResult,
  isSubagentMessage,
  isTerminalAgentTaskStatus,
  isTodoTool,
  applyClaudeTaskTool,
  noticeFromSystem,
  normalizeClaudeCliEffort,
  parseBackgroundTasks,
  parseControlCancelId,
  parseControlRequest,
  parseJsonLine,
  parseTaskNotification,
  parseTaskProgress,
  parseTaskStarted,
  parseTaskUpdated,
  parseToolProgress,
  taskListFromTodos,
  previewFromTool,
  resolveClaudeApiModelId,
  runtimeModeToPermission,
  sessionIdFromMessage,
  statusTextFromSystem,
  streamDeltaFromEvent,
  stringField,
  summarizeToolRequest,
  approvalCall,
  toClaudePermissionResult,
  toolKindFromName,
  toolResultsFromUserMessage,
  toolStartFromEvent,
  toolTitle,
  tryParseJsonRecord,
  turnStatusFromResult,
  usageLimitFromRateLimitEvent,
  parseControlResponse,
  type ClaudeAgentTaskNotification,
  type ClaudeControlResponse,
  type ClaudeCliSettings,
  type ClaudeControlRequest,
} from "./claudeProtocol";
import { forwardChildAnswer, type SessionPort } from "../../../../features/sessions/model/childApproval";
import { claudeRetryFromMessage } from "./claudeFailure";
import { withDevCopiesOff } from "./devCopies";
import { withWorkerNotificationsOff } from "./quietWorkers";
import { workerCheckoutsArgs } from "./workerCheckouts";
import { addDirsOf, cheapExploreLaunch } from "./explorePin";
import { appIdentity, isDevCopy } from "../../../../app/model/appIdentity";
import {
  GOAL_CHECK_CAP,
  GOAL_CLEAR,
  goalCommand,
  goalFromBrief,
  goalOpen,
  goalView,
  nextGoal,
  restoredGoal,
  type GoalTrack,
} from "./claudeGoal";
import {
  appliedLaunch,
  claudeLaunchDelta,
  joinLabels,
  type ClaudeLaunch,
  type ClaudeLiveRequest,
} from "./claudeLaunch";
import {
  claimIdleCompaction,
  confirmIdleCompactionClaim,
  forgetPromptCache,
  idleCompactGivenUp,
  IDLE_COMPACT_CLAIM_CONFIRM_MS,
  noteIdleCompactFailure,
  promptCacheTtlFromUsage,
  recallPromptCache,
  releaseIdleCompactionClaim,
  rememberPromptCache,
} from "./claudePromptCache";
import {
  contextCeilingFor,
  formatDuration,
  IDLE_COMPACT_NOTICE,
  idleCompactionDue,
  warmContextCeiling,
} from "../../../../features/sessions/model/contextCeiling";
import { formatTokens } from "../../../../features/sessions/model/contextUsage";
import { RUNTIME_MODE_LABEL } from "../../../../features/sessions/model/session";
import {
  CLAUDE_WORKFLOW_TASK_TYPE,
  applyWorkflowProgress,
  endWorkflowRun,
  isClaudeWorkflowTaskType,
  isClaudeWorkflowTool,
  isWorkflowLaunchAck,
  startWorkflowRun,
  workflowEndStatus,
  workflowFrame,
} from "./claudeWorkflow";
import type {
  WorkflowRunMeta,
  WorkflowRunStatus,
} from "../../../../features/sessions/model/workflowRun";
import { isAgentToolName } from "../../core/preview";
import { joinStreamText, snapshotRemainder } from "../../core/streamText";
import {
  questionPromptTitle,
  questionsFromUnknown,
  type UserQuestionReply,
} from "../../../../features/sessions/model/userQuestion";
import type {
  ApprovalDecision,
  CompactContextInput,
  HarnessEvent,
  HarnessSessionInput,
  LiveSettingsInput,
  LiveSettingsOutcome,
  SendTurnInput,
  SteerTurnInput,
} from "../../core/types";
import { claudeBridgeKind, claudeRunsOnSubscriptionBridge } from "./claudeDeepseekBridge";
import { bridgeLaunchModel } from "../../../../features/sessions/model/deepseekBridge";

/**
 * A PermissionRequest hook can decide before the user touches the prompt; Claude
 * then cancels the control request out from under us. That is not a rejection,
 * so it gets its own outcome instead of being folded into "deny".
 */
type ApprovalOutcome = ApprovalDecision | "cancelled";

type PendingApproval = {
  requestId: string;
  input: Record<string, unknown>;
  resolve: (decision: ApprovalOutcome) => void;
};

type PendingQuestion = {
  requestId: string;
  event: Extract<HarnessEvent, { type: "question.asked" }>;
  resolve: (reply: UserQuestionReply | "cancelled") => void;
};

type InFlightTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson: string;
  title: string;
  /** An Agent call whose result has come back: its run is over. */
  settled?: boolean;
};

type LiveAgentTask = {
  taskId: string;
  toolUseId?: string;
  description: string;
  backgrounded: boolean;
};

type BackgroundTask = {
  description: string;
  toolUseId?: string;
  kind: CutWork["kind"];
};

/** A workflow run in this turn and the tool call its row hangs off. */
type LiveWorkflow = {
  callId: string;
  run: WorkflowRunMeta;
};

type Live = {
  /** MonoCode session id this process serves. */
  threadId: string;
  cwd: string;
  claudeSessionId: string;
  providerAccountId?: string;
  runtimeMode: RuntimeMode;
  planning: boolean;
  /** What this process was started with, as changed live since. */
  launch: ClaudeLaunch;
  /** The chat's model and settings for its latest turn (a dropped reasoning level is said against these). */
  target?: { model?: string; modelSettings: Record<string, string> };
  /** Control requests waiting on their answer, by request id. */
  pendingControls: Map<string, (response: ClaudeControlResponse) => void>;
  onEvent: (event: HarnessEvent) => void;
  approvals: Map<number, PendingApproval>;
  /** WP-122: a child tool id, and the port its approval answer is written to. */
  childTools: Map<string, { name: string; sessionPort: string }>;
  childPorts: Map<string, SessionPort>;
  childInputs: Map<string, Record<string, unknown>>;
  questions: Map<number, PendingQuestion>;
  visibleQuestionId: number | null;
  nextApprovalUiId: number;
  nextControlId: number;
  toolsByIndex: Map<number, InFlightTool>;
  toolsById: Map<string, InFlightTool>;
  agentTasks: Map<string, LiveAgentTask>;
  /** Workflow runs by task id. */
  workflows: Map<string, LiveWorkflow>;
  /**
   * Every task Claude still runs for this session, by id: subagents, shells it
   * backgrounded, monitors. Each one ends in a notification that wakes Claude
   * for another turn, so the MonoCode turn stays open until they are done.
   */
  backgroundTasks: Map<string, BackgroundTask>;
  /** Rows shown for tasks still running when Claude yielded, by task id. */
  backgroundRows: Map<string, string>;
  /** A task finished after Claude yielded; its follow-up turn is on the way. */
  awaitingResume: ReturnType<typeof setTimeout> | null;
  /** Claude yielded with only backgrounded shells left: the turn is let go after SHELL_HOLD_MS. */
  shellHold: ReturnType<typeof setTimeout> | null;
  /** Last background list sent to the UI, to skip repeats. */
  backgroundKey: string;
  /** Last background work (with ids) sent to the UI, to skip repeats. */
  cutWorkKey: string;
  /**
   * The conversation `--resume` named has no transcript any more ("No conversation found"). The process is about to
   * exit; the turn starts over in a fresh conversation from the chat's brief.
   */
  deadConversation?: string;
  /** Finished-subagent notes held until Claude picks the thread back up. */
  taskNotes: string[];
  /** TaskCreate/TaskUpdate items, keyed by Claude's task id. */
  claudeTasks: Map<string, TaskListItem>;
  turnResultSeen: boolean;
  /** The last `total_cost_usd` this process reported: the CLI's running total, so a turn's own cost is the step from it. */
  lastTotalCostUsd?: number;
  /**
   * Prompts written into this MonoCode turn that Claude hasn't answered yet: the turn's own, a follow-up written after
   * Claude yielded, the `/goal` sent behind a brief. A background wake Claude runs first (its result says
   * origin task-notification) never answers one, so it can't end the turn while a prompt still waits behind it.
   */
  promptsOwed: number;
  /** Claude Code's /goal in this conversation (claudeGoal.ts). */
  goal: GoalTrack | null;
  /** Latest `rate_limit_event` refused requests; reported when the turn ends. */
  usageLimit: { resetsAt?: number } | null;
  /**
   * `error` on the latest main-thread assistant message: the CLI's own label
   * ("authentication_failed", "billing_error", …) for a request that failed.
   */
  assistantError?: string;
  cancelled: boolean;
  muteUpdates: boolean;
  turns: Promise<void>;
  turnDone: (() => void) | null;
  turnFailed: ((error: Error) => void) | null;
  turnEndPending: boolean;
  activeTurn: boolean;
  initDone: (() => void) | null;
  initialized: boolean;
  emittedAssistant: string;
  emittedReasoning: string;
  pendingAssistantBoundary: boolean;
  manualCompaction: boolean;
  compactionConfirmed: boolean;
  /** A compaction the app started on its own: its failure is a note, not an error. */
  quietCompaction: boolean;
  /** Latest main-thread context level, for the prompt-cache record. */
  contextUsed?: number;
};

type Resume = {
  sessionId: string;
  cwd: string;
  providerAccountId?: string;
};

const INIT_TIMEOUT_MS = 8_000;

/** The note a chat shows when its Claude conversation was gone and a fresh one started from its brief. */
export const RECOVERED_FROM_BRIEF =
  "Claude's saved conversation for this chat was gone, so this turn started a fresh one from the chat's brief.";

/**
 * `--resume` named a conversation Claude Code has no transcript for. Recovered once per turn: the id is dropped and
 * the turn runs in a fresh conversation, told the chat so far through its brief.
 */
class DeadConversationError extends Error {
  constructor(
    readonly providerSessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "DeadConversationError";
  }
}
/**
 * How long a finished background task may take to wake Claude before the turn
 * is let go anyway. The follow-up turn normally starts within a second or two.
 */
const RESUME_GRACE_MS = 15_000;
/**
 * How long Claude may sit yielded with only shells it backgrounded still going before the turn is let go. A dev server
 * or a watcher never finishes, so waiting for it held a worker "running" for good and its report never reached its Lead
 * (Ash day AD3 on Grok: the worker answered "no footer fault, no commit" and left `python -m http.server` up). The
 * shells keep running and keep their rows; a later wake still shows in the chat. Subagents and monitors still hold.
 */
const SHELL_HOLD_MS = 60_000;

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
/**
 * Claude task lists outlive a Live: a restart that resumes the conversation
 * keeps its task ids, so later TaskUpdate calls must find earlier tasks. Task
 * ids belong to one Claude conversation, so each map records which one.
 */
const tasksByThread = new Map<
  string,
  { providerSessionId: string; tasks: Map<string, TaskListItem> }
>();
/** Reasoning levels each chat was already told its provider refused (model id|level), so the line shows once. */
const effortNoticesByThread = new Map<string, Set<string>>();

/**
 * A routed chat whose provider refused its level got the provider's default instead: say so in one plain line, once
 * per chat and level. Read at the turn's result, after the router announced the refusal (it does so before the
 * retried answer goes back to Claude Code).
 */
function noteDroppedEffort(live: Live): void {
  if (!live.target || live.muteUpdates) return;
  let shown = effortNoticesByThread.get(live.threadId);
  if (!shown) effortNoticesByThread.set(live.threadId, (shown = new Set()));
  const text = effortDroppedNotice(live.target, shown);
  if (text) live.onEvent({ type: "notice", key: "effort-dropped", text });
}

/** Task-list block key for TaskCreate/TaskUpdate items. */
const CLAUDE_TASKS_KEY = "claude-tasks";
const cancelledThreads = new Set<string>();
/** Threads whose dead conversation was dropped: their next fresh turn carries the chat's brief, once. */
const briefOwed = new Set<string>();
/**
 * Each chat's /goal outlives its Claude process: `--resume` keeps the goal in the conversation, but a fresh one (a
 * Mono's rotation, a dead conversation started again) has lost it, so the next turn sets it again.
 */
const goalByThread = new Map<string, GoalTrack>();
/** The goal each chat last finished in this process (met, cleared, stopped): a saved copy of it is never restored. */
const goalEnded = new Map<string, string>();
const goalKey = (goal: Pick<GoalTrack, "objective" | "setAt">) => `${goal.setAt}\u0000${goal.objective}`;

let resolveClaudeBinaryImpl: () => Promise<{ path: string }> =
  resolveClaudeBinary;

/** Test seam. */
export function setClaudeBinaryResolver(
  fn: () => Promise<{ path: string }>,
): void {
  resolveClaudeBinaryImpl = fn;
}

export async function sendClaudeTurn(input: SendTurnInput): Promise<void> {
  try {
    await sendClaudeTurnOnce(input);
  } catch (error) {
    if (!(error instanceof DeadConversationError)) throw error;
    forgetDeadConversation(input, error);
    // The process that said so is on its way out; never hand the retry to it.
    await stopClaudeSession(input.sessionId);
    // Once: a fresh conversation can't be missing, so whatever fails now is a real failure.
    try {
      await sendClaudeTurnOnce(input);
    } catch (retry) {
      if (retry instanceof DeadConversationError) throw new Error(retry.message);
      throw retry;
    }
  }
}

/** Drop a dead conversation's id everywhere, tell the chat, and owe the next fresh turn the chat's brief. */
function forgetDeadConversation(
  input: Pick<SendTurnInput, "sessionId" | "onEvent">,
  error: DeadConversationError,
): void {
  if (resumeByThread.get(input.sessionId)?.sessionId === error.providerSessionId)
    resumeByThread.delete(input.sessionId);
  tasksByThread.delete(input.sessionId);
  forgetPromptCache(input.sessionId);
  briefOwed.add(input.sessionId);
  input.onEvent({
    type: "session.providerLost",
    providerSessionId: error.providerSessionId,
    text: RECOVERED_FROM_BRIEF,
  });
}

async function sendClaudeTurnOnce(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;
  // Read before any wrapping below: a wrapped brief no longer starts as one, and its finish line would be lost.
  const briefGoal = goalFromBrief(input.text);
  // The first turn of a fresh conversation after a dead one: the chat so far comes with it.
  if (briefOwed.delete(input.sessionId) && input.resumeFallback) {
    input = { ...input, text: input.resumeFallback(input.text) };
  }

  live.onEvent = input.onEvent;
  live.runtimeMode = input.runtimeMode;
  // WP-176: the ceiling is judged against this turn's model, not the one the process started with.
  live.target = { model: input.model, modelSettings: input.modelSettings ?? {} };
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await compactIfIdle(live, input);
        if (live.cancelled) return;
        await runTurn(live, input, { briefGoal });
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  await live.turns;
}

/**
 * Quiet `/compact` through the same path a person uses. Failure is a result
 * for the caller, not a session error. A finished compact drops the claim a
 * background look took, because remembering the record strips it.
 */
async function runQuietCompact(live: Live, input: HarnessSessionInput): Promise<void> {
  live.manualCompaction = true;
  live.quietCompaction = true;
  live.compactionConfirmed = false;
  try {
    await runTurn(
      live,
      {
        ...input,
        modelSettings: undefined,
        text: "/compact",
        attachments: [],
        onAccepted: undefined,
      },
      { reportErrors: false },
    );
    if (!live.compactionConfirmed) {
      throw new Error("Claude Code did not confirm the compaction");
    }
    live.contextUsed = undefined;
    rememberPromptCache(input.sessionId, {
      providerSessionId: live.claudeSessionId,
      lastTurnAt: Date.now(),
      contextUsed: 0,
      compactFailures: 0,
    });
  } finally {
    live.manualCompaction = false;
    live.quietCompaction = false;
  }
}

/**
 * A big chat idle past its prompt cache would have its whole context written
 * to the cache again, at full price, by this message and then kept that size.
 * Compacting first costs one read and leaves every later turn small. Only
 * once the cache has already expired: inside the early window the idle
 * watcher compacts, and a send must not.
 */
async function compactIfIdle(live: Live, input: SendTurnInput): Promise<void> {
  if (input.text.trim().startsWith("/")) return;
  const state = recallPromptCache(input.sessionId);
  if (!state || state.providerSessionId !== live.claudeSessionId) return;
  const due = idleCompactionDue(state, Date.now());
  if (!due?.expired) return;
  live.onEvent({
    type: "status",
    text: `Idle ${formatDuration(due.idleMs)}, past the ${formatDuration(due.ttlMs)} prompt cache: compacting ${formatTokens(due.used)} tokens before sending, so the cache is not rebuilt at full size`,
  });
  try {
    await runQuietCompact(live, input);
  } catch (error) {
    if (live.cancelled) return;
    // A conversation that is gone is not a compaction failure: the dead
    // conversation path starts a fresh one, which has nothing to compact.
    if (error instanceof DeadConversationError) throw error;
    live.onEvent({
      type: "notice",
      level: "warning",
      text: `Could not compact first (${error instanceof Error ? error.message : String(error)}); sending as is.`,
    });
  }
}

export async function compactClaudeContext(
  input: CompactContextInput,
): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    // Nothing to compact in a conversation that is gone; the next turn starts fresh from the brief.
    if (!(error instanceof DeadConversationError)) throw error;
    forgetDeadConversation(input, error);
    return;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.runtimeMode = input.runtimeMode;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      live.manualCompaction = true;
      live.compactionConfirmed = false;
      try {
        await runTurn(live, {
          ...input,
          modelSettings: undefined,
          text: "/compact",
          attachments: [],
        });
        if (!live.compactionConfirmed) {
          throw new Error("Claude Code did not confirm context compaction");
        }
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      } finally {
        live.manualCompaction = false;
      }
    });
  await live.turns;
}

/**
 * The caller's busy hold for one background compact. `begin` is asked once,
 * right before the compact runs, after every check that can turn the compact
 * away (the window, the conversation, the claim). It returns false when the
 * chat was taken in the meantime. `end` runs when the compact is over, however
 * it ended.
 */
export type IdleCompactHold = { begin: () => boolean; end: () => void };

/**
 * Compact one idle Claude chat inside the two-minute window before its prompt
 * cache expires. A cache that has already expired is left for the next send.
 * Does not send the person's message. A mid-turn chat, a chat that has left
 * the window, a chat whose last two background compacts failed, and a claim
 * another window holds are left alone. Failure releases the claim so a later
 * look can retry; it is not a session error.
 * `proceed` is read again after the wait, because the chat may have gone.
 */
export async function compactDueIdleClaude(
  input: HarnessSessionInput,
  proceed: () => boolean = () => true,
  hold?: IdleCompactHold,
): Promise<boolean> {
  if (!proceed()) return false;
  const state = recallPromptCache(input.sessionId);
  const due = state ? idleCompactionDue(state, Date.now()) : null;
  // Only inside the lead window. An expired cache waits for the next send.
  if (!state || !due || due.expired || idleCompactGivenUp(state)) return false;
  const liveNow = liveByThread.get(input.sessionId);
  if (liveNow?.activeTurn) return false;
  const bound = liveNow?.claudeSessionId ?? resumeByThread.get(input.sessionId)?.sessionId;
  if (!bound || bound !== state.providerSessionId) return false;

  const claimId = crypto.randomUUID();
  if (!claimIdleCompaction(input.sessionId, claimId, Date.now())) return false;
  await new Promise((resolve) => setTimeout(resolve, IDLE_COMPACT_CLAIM_CONFIRM_MS));
  if (!confirmIdleCompactionClaim(input.sessionId, claimId, Date.now())) return false;

  const release = () => releaseIdleCompactionClaim(input.sessionId, claimId);
  const stillDue = () => {
    const fresh = recallPromptCache(input.sessionId);
    if (!fresh || fresh.providerSessionId !== state.providerSessionId) return false;
    const freshDue = idleCompactionDue(fresh, Date.now());
    return freshDue !== null && !freshDue.expired;
  };
  if (!proceed() || liveByThread.get(input.sessionId)?.activeTurn || !stillDue()) {
    release();
    return false;
  }

  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    release();
    if (error instanceof DeadConversationError) forgetDeadConversation(input, error);
    return false;
  }
  if (cancelledThreads.delete(input.sessionId) || live.claudeSessionId !== state.providerSessionId) {
    release();
    return false;
  }

  let done = false;
  live.onEvent = input.onEvent;
  live.runtimeMode = input.runtimeMode;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      if (live.cancelled || live.activeTurn || !proceed() || !stillDue()) {
        release();
        return;
      }
      if (!confirmIdleCompactionClaim(input.sessionId, claimId, Date.now())) return;
      // Every check that can turn this compact away has passed. Only now is
      // the chat held busy, so one that fails them never flickers.
      if (hold && !hold.begin()) {
        release();
        return;
      }
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await runQuietCompact(live, input);
        if (proceed()) live.onEvent({ type: "notice", text: IDLE_COMPACT_NOTICE });
        done = true;
      } catch (error) {
        if (error instanceof DeadConversationError) {
          forgetDeadConversation(input, error);
          return;
        }
        // Cancelled or the compact did not land. Retry later. No error line:
        // nobody was waiting on this to send.
        release();
        // A compact that did not land, as opposed to one the person stopped,
        // counts. Two in a row and this chat is left alone until its next turn.
        if (!live.cancelled) noteIdleCompactFailure(input.sessionId, state.providerSessionId);
      } finally {
        hold?.end();
      }
    });
  await live.turns;
  return done;
}

export async function steerClaudeTurn(input: SteerTurnInput): Promise<void> {
  const live = liveByThread.get(input.sessionId);
  if (!live?.activeTurn) throw new TurnNotReadyError("No active turn to steer");

  const message = buildClaudeUserMessage({
    text: input.text,
    attachments: input.attachments,
    effort: input.modelSettings?.effort,
  });
  const content = (message.message as { content: unknown[] }).content;
  if (content.length === 0) return;

  await writeJson(input.sessionId, message);
  // Written after Claude yielded (it waits on background work), this is a prompt of its own that the turn now owes
  // an answer to; written mid-reply it joins the reply already owed.
  live.promptsOwed = Math.max(live.promptsOwed, 1);
}

/**
 * Whether this copy sends /goal at all. Not while Claude's hooks are off (the CLI refuses /goal then: "Done when" in
 * the brief is all there is), which a dev copy always runs with (harness.rs keeps Ash's hooks out of it); the one
 * exception is the fake-Claude bench, whose plan says its fake takes /goal (verify_live.rs `goals`).
 */
export function goalsAllowed(): boolean {
  if (!loadClaudeHooks()) return false;
  return !isDevCopy() || appIdentity()?.verify?.goals === true;
}

/**
 * The /goal this turn sets, if any: a MonoCode brief's "Done when: …" (read from the text as it was sent, before any
 * recovery wrapping), or the goal this chat had in a conversation it no longer has (a rotation, a dead conversation
 * started again, a restart that found its transcript gone). None when this copy sends no /goal (goalsAllowed), or for
 * /compact.
 */
function goalToSet(live: Live, input: SendTurnInput, briefGoal: string | undefined): string | undefined {
  if (live.manualCompaction || !goalsAllowed()) return undefined;
  const fresh = briefGoal ?? goalFromBrief(input.text);
  if (fresh) return fresh;
  const carried = goalByThread.get(input.sessionId);
  return goalOpen(carried) && carried.providerSessionId !== live.claudeSessionId
    ? carried.objective
    : undefined;
}

/**
 * Follow the chat's /goal through one main-thread line and tell the chat when it changes. The CLI's own goal
 * messages ("Goal set: …", "Goal active: …") become a status line instead of words in Claude's reply. Past
 * GOAL_CHECK_CAP checks MonoCode clears the goal, and the turn waits for that too. True when the line is consumed.
 */
function noteGoal(sessionId: string, live: Live, rec: Record<string, unknown>): boolean {
  if (isSubagentMessage(rec)) return false;
  // A compaction's result ends no turn of Claude's: whatever stop was pending is still unchecked.
  if (live.manualCompaction && stringField(rec, "type") === "result") return false;
  // The CLI refusing /goal ("/goal can't run while hooks are restricted …") is a status line, never the reply a
  // worker's report would carry.
  if (
    stringField(rec, "type") === "assistant" &&
    (rec.message as { model?: unknown } | undefined)?.model === "<synthetic>"
  ) {
    const said = assistantTextBlocks(rec).join("").trim();
    if (/^(\/goal |Goal condition is limited)/.test(said)) {
      live.onEvent({ type: "status", text: said });
      return true;
    }
  }
  let next = nextGoal(live.goal, rec, Date.now());
  if (next === undefined) return false;
  const before = goalView(live.goal);
  const carried = goalByThread.get(sessionId);
  // Set again in a fresh conversation: the checks it already had still count toward the cap.
  if (next && !live.goal && carried && carried.objective === next.objective && next.checks === 0)
    next = { ...next, checks: carried.checks, setAt: carried.setAt, ...(carried.lastCheck ? { lastCheck: carried.lastCheck } : {}) };
  if (next) next = { ...next, providerSessionId: live.claudeSessionId };
  const capped = goalOpen(next) && next.checks >= GOAL_CHECK_CAP && !next.clearing;
  if (capped) next = { ...next!, clearing: true };
  setGoal(sessionId, live, next, before);
  if (capped) clearCappedGoal(sessionId, live, next!);
  if (stringField(rec, "type") !== "assistant") return false;
  if ((rec.message as { model?: unknown } | undefined)?.model !== "<synthetic>") return false;
  const said = assistantTextBlocks(rec).join("").trim();
  if (said) live.onEvent({ type: "status", text: said });
  return true;
}

/**
 * Stop mutes the cut turn's result, so the stop Claude was making never reaches the goal's evaluator: nothing is
 * pending any more, and a later result can't count it as a pass.
 */
function dropPendingGoalCheck(sessionId: string, live: Live): void {
  if (live.goal?.pendingCheck) live.goal = { ...live.goal, pendingCheck: false };
  const carried = goalByThread.get(sessionId);
  if (carried?.pendingCheck) goalByThread.set(sessionId, { ...carried, pendingCheck: false });
}

/** Keep the chat's goal and tell the chat when what it shows changed. */
function setGoal(sessionId: string, live: Live, next: GoalTrack | null, before = goalView(live.goal)): void {
  live.goal = next;
  if (goalOpen(next)) goalByThread.set(sessionId, next);
  else {
    goalByThread.delete(sessionId);
    if (next) goalEnded.set(sessionId, goalKey(next));
  }
  const view = goalView(next);
  if (JSON.stringify(view) !== JSON.stringify(before)) live.onEvent({ type: "goal.updated", goal: view });
}

/**
 * Past GOAL_CHECK_CAP checks MonoCode clears the goal itself. It reads stopped once `/goal clear` has gone in, and the
 * turn waits for that prompt's answer too; a clear that can't be written leaves the goal open (the next check tries
 * again), owes nothing, and says so.
 */
function clearCappedGoal(sessionId: string, live: Live, goal: GoalTrack): void {
  const owed = live.activeTurn;
  if (owed) live.promptsOwed += 1;
  const same = (current: GoalTrack | null): current is GoalTrack =>
    !!current && goalKey(current) === goalKey(goal);
  writeJson(sessionId, buildClaudeUserMessage({ text: GOAL_CLEAR })).then(
    () => {
      if (same(live.goal) && goalOpen(live.goal)) setGoal(sessionId, live, { ...live.goal, status: "stopped" });
    },
    (error: unknown) => {
      if (owed) live.promptsOwed = Math.max(0, live.promptsOwed - 1);
      if (same(live.goal) && live.goal.clearing) {
        const { clearing: _clearing, ...open } = live.goal;
        setGoal(sessionId, live, open);
      }
      if (live.muteUpdates) return;
      live.onEvent({
        type: "notice",
        key: "claude-goal-clear",
        level: "warning",
        text: `Could not clear the goal after ${GOAL_CHECK_CAP} checks (${error instanceof Error ? error.message : String(error)}); Claude Code still holds it.`,
      });
    },
  );
}

/** A result for a background wake Claude ran by itself (a task finished), not for a prompt MonoCode wrote. */
function isWakeResult(rec: Record<string, unknown>): boolean {
  return stringField(asRecord(rec.origin), "kind") === "task-notification";
}

/**
 * Claude answered a wake, or the first of two prompts, while a prompt of this turn still waits: keep the turn open for
 * the answer that is on its way. If Claude starts nothing within RESUME_GRACE_MS, the turn is let go anyway.
 */
function holdForOwedPrompt(live: Live): void {
  if (live.promptsOwed <= 0 || !live.activeTurn || live.cancelled) return;
  clearAwaitingResume(live);
  live.awaitingResume = setTimeout(() => {
    live.awaitingResume = null;
    live.promptsOwed = 0;
    maybeFinishTurn(live);
    syncBackgroundWait(live);
  }, RESUME_GRACE_MS);
}

export function respondClaudeApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.approvals.get(requestId);
  if (!pending) return;
  pending.resolve(decision);
}

export function respondClaudeQuestion(
  sessionId: string,
  requestId: number,
  reply: UserQuestionReply,
): void {
  const live = liveByThread.get(sessionId);
  const pending = live?.questions.get(requestId);
  if (!pending) return;
  pending.resolve(reply);
}

export async function cancelClaudeTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  // A stopped run's last frames arrive after the stop and are muted, so its
  // row is settled here or it would read as working for good.
  settleWorkflows(live, "stopped");
  live.cancelled = true;
  live.muteUpdates = true;
  dropPendingGoalCheck(sessionId, live);
  for (const [, pending] of live.approvals) pending.resolve("deny");
  live.approvals.clear();
  for (const [, pending] of live.questions)
    pending.resolve({ kind: "skipped" });
  live.questions.clear();
  // Stop means the whole run, including what Claude left going in the
  // background. Otherwise it finishes later and wakes Claude up again.
  for (const taskId of live.backgroundTasks.keys()) {
    await writeJson(
      sessionId,
      buildControlRequest(nextControlId(live), {
        subtype: "stop_task",
        task_id: taskId,
      }),
    ).catch(() => undefined);
  }
  await writeJson(
    sessionId,
    buildControlRequest(nextControlId(live), { subtype: "interrupt" }),
  ).catch(() => undefined);
  // A turn that already settled must not arm the next one.
  if (live.activeTurn || live.turnDone) {
    finishActiveTurn(live, [
      { type: "message.completed" },
      { type: "reasoning.completed" },
    ]);
  }
}

export async function stopClaudeSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    settleWorkflows(live, "stopped");
    live.muteUpdates = true;
    // WP-122: the process is going away, so a courtesy deny is not a delivered child answer.
    live.childPorts.clear();
    dropPendingGoalCheck(sessionId, live);
    for (const [, pending] of live.approvals) pending.resolve("deny");
    live.approvals.clear();
    for (const [, pending] of live.questions)
      pending.resolve({ kind: "skipped" });
    live.questions.clear();
    live.activeTurn = false;
    live.turnDone?.();
    live.turnDone = null;
    live.turnFailed = null;
    live.initDone?.();
    live.initDone = null;
  }
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetClaudeSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  tasksByThread.delete(sessionId);
  briefOwed.delete(sessionId);
  forgetPromptCache(sessionId);
  await stopClaudeSession(sessionId);
}

/**
 * The chat was deleted: its goal state goes too. Kept apart from forgetClaudeSession, which a Mono's rotation uses and
 * whose fresh conversation must get the open goal again.
 */
export function dropClaudeSession(sessionId: string): void {
  goalByThread.delete(sessionId);
  goalEnded.delete(sessionId);
}

export function bindClaudeSession(
  threadId: string,
  providerSessionId: string,
  cwd: string,
  providerAccountId?: string,
): void {
  const sessionId = providerSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { sessionId, cwd, providerAccountId });
  // Task ids from another conversation mean nothing in this one.
  if (tasksByThread.get(threadId)?.providerSessionId !== sessionId) {
    tasksByThread.delete(threadId);
  }
}

/**
 * A restored chat's saved /goal (after a restart): the harness carries on with it. A resumed conversation still has it
 * in Claude Code, so nothing is sent and its checks go on from the saved count; a fresh one (the transcript was gone,
 * a rotation) gets `/goal` once with its next turn (goalToSet). A goal this process already follows wins.
 */
export function restoreClaudeGoal(threadId: string, goal: SessionGoal): void {
  if (!threadId || goalByThread.has(threadId) || liveByThread.get(threadId)?.goal) return;
  const restored = restoredGoal(goal);
  if (restored && goalEnded.get(threadId) !== goalKey(restored)) goalByThread.set(threadId, restored);
}

/**
 * Seed the task map from a restored session's persisted panel. After an app
 * restart only the transcript survives, and a resumed conversation still
 * refers to its earlier task ids.
 */
export function restoreClaudeTaskLists(
  threadId: string,
  lists: TaskListMeta[],
): void {
  if (!threadId || tasksByThread.has(threadId)) return;
  // Only a list produced by the conversation bound to this thread applies.
  const providerSessionId = resumeByThread.get(threadId)?.sessionId;
  if (!providerSessionId) return;
  let items: TaskListItem[] = [];
  for (const entry of lists) {
    if (entry.key !== CLAUDE_TASKS_KEY) continue;
    if (entry.providerSessionId !== providerSessionId) continue;
    items = entry.items.filter((item) => item.id);
  }
  if (items.length === 0) return;
  tasksByThread.set(threadId, {
    providerSessionId,
    tasks: new Map(items.map((item) => [item.id!, { ...item }])),
  });
}

async function ensureLive(input: HarnessSessionInput): Promise<Live> {
  // WP-104: a custom route's context window comes from the bundled catalogue, read on first use. Wait for it before
  // any launch is computed, so the key compared below and the settings started with agree.
  await warmContextCeiling(input.model);
  const planning = input.intent === "plan";
  // WP-41: one wiring snapshot feeds the append text and the plugin dirs, before the launch key is compared.
  const plugins = await claudePluginLaunch(input.cwd, input.sessionId);
  const sessionAppend = plugins.append;
  noteSessionAppend(input.sessionId, sessionAppend);
  const append = mergeClaudeAppend(claudeAppend(input.sessionId), sessionAppend);
  const launchNext = claudeLaunchFor(input, append);
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    existing.cwd === input.cwd &&
    sameProviderAccountId(existing.providerAccountId, input.providerAccountId)
  ) {
    existing.onEvent = input.onEvent;
    existing.target = { model: input.model, modelSettings: input.modelSettings ?? {} };
    const delta = claudeLaunchDelta(existing.launch, launchNext);
    if (delta.restart.length === 0) {
      const applied =
        delta.requests.length === 0 ||
        (await applyLiveRequests(input.sessionId, existing, delta.requests));
      if (applied) {
        if (delta.requests.length > 0) {
          noteAppliedLive(existing, delta.requests, input);
        }
        existing.launch = appliedLaunch(existing.launch, launchNext);
        existing.planning = planning;
        existing.runtimeMode = input.runtimeMode;
        return existing;
      }
      input.onEvent({
        type: "notice",
        text: `Claude Code could not change its ${joinLabels(delta.requests.map((r) => r.label))} live; restarting it with the new settings.`,
      });
    } else {
      input.onEvent({
        type: "notice",
        text: `Restarting Claude Code for the ${joinLabels(delta.restart)} change; the conversation carries on.`,
      });
    }
  }
  if (existing) {
    // Model and launch-setting changes require a fresh Claude process, but
    // they must resume the same provider conversation. Only a cwd change
    // invalidates the stored session because Claude sessions are cwd-bound.
    if (existing.cwd !== input.cwd) resumeByThread.delete(input.sessionId);
    await stopClaudeSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canResume =
    resume != null &&
    resume.cwd === input.cwd &&
    sameProviderAccountId(resume.providerAccountId, input.providerAccountId);
  if (
    resume &&
    (resume.cwd !== input.cwd ||
      !sameProviderAccountId(resume.providerAccountId, input.providerAccountId))
  ) {
    resumeByThread.delete(input.sessionId);
  }
  const { path } = await resolveClaudeBinaryImpl();
  const liveRef: { current: Live | null } = { current: null };
  const claudeSessionId =
    canResume && resume ? resume.sessionId : crypto.randomUUID();
  const retained = tasksByThread.get(input.sessionId);
  const claudeTasks =
    retained?.providerSessionId === claudeSessionId
      ? retained.tasks
      : new Map<string, TaskListItem>();
  tasksByThread.set(input.sessionId, {
    providerSessionId: claudeSessionId,
    tasks: claudeTasks,
  });
  const launch = launchOptions(
    input,
    canResume ? resume?.sessionId : undefined,
    claudeSessionId,
  );

  const live: Live = {
    threadId: input.sessionId,
    cwd: input.cwd,
    claudeSessionId,
    providerAccountId: input.providerAccountId,
    runtimeMode: input.runtimeMode,
    planning,
    launch: launchNext,
    target: { model: input.model, modelSettings: input.modelSettings ?? {} },
    pendingControls: new Map(),
    onEvent: input.onEvent,
    approvals: new Map(),
    childTools: new Map(),
    childPorts: new Map(),
    childInputs: new Map(),
    questions: new Map(),
    visibleQuestionId: null,
    nextApprovalUiId: 1,
    nextControlId: 1,
    toolsByIndex: new Map(),
    toolsById: new Map(),
    agentTasks: new Map(),
    workflows: new Map(),
    backgroundTasks: new Map(),
    shellHold: null,
    backgroundRows: new Map(),
    awaitingResume: null,
    backgroundKey: "",
    cutWorkKey: "",
    taskNotes: [],
    claudeTasks,
    turnResultSeen: false,
    promptsOwed: 0,
    // A resumed conversation still has its goal; a fresh one gets it again with its next turn (runTurn).
    goal:
      goalByThread.get(input.sessionId)?.providerSessionId === claudeSessionId
        ? goalByThread.get(input.sessionId)!
        : null,
    usageLimit: null,
    cancelled: false,
    muteUpdates: false,
    turns: Promise.resolve(),
    turnDone: null,
    turnFailed: null,
    turnEndPending: false,
    activeTurn: false,
    initDone: null,
    initialized: false,
    emittedAssistant: "",
    emittedReasoning: "",
    pendingAssistantBoundary: false,
    manualCompaction: false,
    compactionConfirmed: false,
    quietCompaction: false,
  };
  liveRef.current = live;

  watchChild(
    input.sessionId,
    (line) => {
      const current = liveRef.current;
      if (!current) return;
      handleLine(input.sessionId, current, line);
    },
    (code) => {
      liveByThread.delete(input.sessionId);
      const current = liveRef.current;
      if (current) clearAwaitingResume(current);
      if (current && !current.muteUpdates) settleWorkflows(current, "failed");
      if (!current?.muteUpdates) {
        (current?.onEvent ?? input.onEvent)({ type: "session.ended", code });
      }
      current?.turnFailed?.(new Error("Claude Code exited"));
      current?.initDone?.();
      if (current) {
        current.turnDone = null;
        current.turnFailed = null;
        current.initDone = null;
      }
    },
  );

  const launchArgs = [
    // Only a chat in Full access starts able to skip permissions; Full
    // access chosen later on any other process restarts it (claudeLaunchDelta).
    ...buildClaudeSpawnArgs({ ...launch, settings: withWorkerNotificationsOff(withDevCopiesOff(launch.settings, input.cwd)), allowBypass: launchNext.allowBypass }),
    ...workerCheckoutsArgs(input.cwd),
    // WP-30: the same snapshot as the append text, not a second read of the plugin wiring (claudeExtraArgs.ts).
    ...(await claudeExtraArgs(input.sessionId, undefined, plugins.additions)),
    // WP-41: the same text the launch key was compared against, not a second read.
    ...claudeAppendArgs(append),
  ];

  // WP-143: a crew or Mono session on Anthropic starts with a cheap Explore agent as a flag, when this CLI knows the flag
  // and the person has no Explore of their own (also not in a folder the session adds). Nothing is written to the
  // folder, and a failure here only means the session starts without it.
  const cheapExplore = await cheapExploreLaunch({
    crew: input.crew === true,
    anthropic: !claudeRunsOnSubscriptionBridge() && !launch.routedModel,
    cwd: input.cwd,
    providerAccountId: input.providerAccountId,
    addDirs: addDirsOf(launchArgs),
    cli: { key: path, version: () => execChild(path, ["--version"], input.cwd, "claude") },
  });

  await spawnChild(
    input.sessionId,
    path,
    [...launchArgs, ...cheapExplore.args],
    input.cwd,
    { provider: "claude", id: input.providerAccountId ?? "default" },
    "claude",
    undefined,
    undefined,
    // Only a custom ("Other models") id has a route; Claude models never do, so they keep the normal login.
    customModelRoute({ model: input.model, modelSettings: input.modelSettings ?? {} }),
  );
  // Said only once the process is up: a launch that failed to start never claims the flag went in.
  if (cheapExplore.sentence) {
    input.onEvent({ type: "status", key: "explore-pin", text: cheapExplore.sentence });
  }

  liveByThread.set(input.sessionId, live);
  resumeByThread.set(input.sessionId, {
    sessionId: claudeSessionId,
    cwd: input.cwd,
    providerAccountId: input.providerAccountId,
  });

  // The meter needs the window before the turn ends: mid-turn Claude Code sends only the level, and it sends
  // the window on the turn's `result`. Ask the router for the provider's own window now, so a routed session
  // draws a real ring from its first reading instead of none. Never awaited as a gate on the turn, and a
  // provider that publishes no window leaves it unknown rather than guessed.
  void seedRoutedWindow(live, input);

  try {
    await writeJson(
      input.sessionId,
      buildControlRequest(nextControlId(live), { subtype: "initialize" }),
    );
    await waitForInit(live, INIT_TIMEOUT_MS);
    if (live.deadConversation) {
      throw new DeadConversationError(
        live.deadConversation,
        `Claude Code has no saved conversation ${live.deadConversation}.`,
      );
    }
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: live.claudeSessionId,
    });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    await stopClaudeSession(input.sessionId);
    throw error;
  }
}

async function runTurn(
  live: Live,
  input: SendTurnInput,
  options: {
    reportErrors?: boolean;
    /** The finish line of the brief this turn sends, read before the text was wrapped. */
    briefGoal?: string;
  } = {},
): Promise<void> {
  const effort = input.modelSettings?.effort;
  const message = buildClaudeUserMessage({
    text: input.text,
    attachments: input.attachments,
    effort,
  });
  const content = (message.message as { content: unknown[] }).content;
  if (content.length === 0) return;

  live.emittedAssistant = "";
  live.emittedReasoning = "";
  live.pendingAssistantBoundary = false;
  live.toolsByIndex.clear();
  live.toolsById.clear();
  live.agentTasks.clear();
  live.workflows.clear();
  live.backgroundTasks.clear();
  live.backgroundRows.clear();
  clearAwaitingResume(live);
  clearShellHold(live);
  live.backgroundKey = "";
  syncCutWork(live);
  live.taskNotes = [];
  live.turnResultSeen = false;
  live.assistantError = undefined;
  live.promptsOwed = 1;

  const turnPromise = new Promise<void>((resolve, reject) => {
    live.turnDone = resolve;
    live.turnFailed = reject;
  });
  live.activeTurn = true;
  settlePendingTurn(live);

  try {
    // A brief's finish line goes in right behind it, so Claude reads the brief first and then keeps going until
    // Claude Code's own evaluator says the condition holds; the turn ends when both are answered. Both are owed before
    // the brief is written: Claude can answer the brief before its write call returns here (on a busy window its
    // output arrives first), and that answer must not end the turn while the /goal is still to go in.
    const goal = goalToSet(live, input, options.briefGoal);
    if (goal) live.promptsOwed += 1;
    await writeJson(input.sessionId, message);
    if (goal) await writeJson(input.sessionId, buildClaudeUserMessage({ text: goalCommand(goal) }));
    input.onAccepted?.();
    // Claude has this prompt now, and with it any note about work a restart cut: from here the chat's background
    // work is this turn's own (none yet), not what a resumed turn carried forward.
    live.cutWorkKey = "\u0000";
    syncCutWork(live);
    settlePendingTurn(live);
    await turnPromise;
  } catch (error) {
    if (live.cancelled) return;
    // Not a failure of the turn: sendClaudeTurn starts it again in a fresh conversation.
    if (error instanceof DeadConversationError) throw error;
    if (options.reportErrors !== false) {
      live.onEvent({
        type: "session.error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    live.turnDone = null;
    live.turnFailed = null;
  }
}

/**
 * Claude Code answered `--resume` with "No conversation found": the transcript is gone. Nothing else from this
 * process matters (it exits next), so the chat hears none of it; the turn is started again fresh.
 */
function noteDeadConversation(live: Live, text: string): void {
  live.deadConversation = live.claudeSessionId;
  live.muteUpdates = true;
  const failed = live.turnFailed;
  live.turnDone = null;
  live.turnFailed = null;
  failed?.(new DeadConversationError(live.claudeSessionId, text));
  markInitialized(live);
}

function handleLine(sessionId: string, live: Live, line: string): void {
  const rec = parseJsonLine(line);
  if (!rec) return;

  const type = stringField(rec, "type");
  if (type === "keep_alive") return;

  const cancelId = parseControlCancelId(rec);
  if (cancelId) {
    for (const [uiId, pending] of live.approvals) {
      if (pending.requestId === cancelId) {
        pending.resolve("cancelled");
        live.approvals.delete(uiId);
      }
    }
    for (const [uiId, pending] of live.questions) {
      if (pending.requestId === cancelId) {
        pending.resolve("cancelled");
        live.questions.delete(uiId);
      }
    }
    return;
  }

  if (type === "control_response") {
    markInitialized(live);
    const answer = parseControlResponse(rec);
    if (answer) live.pendingControls.get(answer.requestId)?.(answer);
    return;
  }

  const control = parseControlRequest(rec);
  if (control) {
    const turn = live.turnDone;
    void handleControlRequest(sessionId, live, control).catch(
      (error: unknown) => {
        if (live.muteUpdates || live.turnDone !== turn) return;
        const failure =
          error instanceof Error ? error : new Error(String(error));
        if (live.turnFailed) {
          live.turnFailed(failure);
        } else {
          live.onEvent({ type: "session.error", message: failure.message });
        }
      },
    );
    return;
  }

  if (live.muteUpdates) return;

  if (type === "result" && !isSubagentMessage(rec)) {
    const dead = deadConversationFromResult(rec);
    if (dead) {
      noteDeadConversation(live, dead);
      return;
    }
  }

  const sessionIdFromLine = sessionIdFromMessage(rec);
  if (sessionIdFromLine && sessionIdFromLine !== live.claudeSessionId) {
    live.claudeSessionId = sessionIdFromLine;
    // A different conversation starts with its own task ids.
    live.claudeTasks = new Map();
    tasksByThread.set(sessionId, {
      providerSessionId: sessionIdFromLine,
      tasks: live.claudeTasks,
    });
    resumeByThread.set(sessionId, {
      sessionId: sessionIdFromLine,
      cwd: live.cwd,
      providerAccountId: live.providerAccountId,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: sessionIdFromLine,
    });
  }

  if (
    type === "system" &&
    (stringField(rec, "subtype") === "init" ||
      stringField(rec, "subtype") === "initialized")
  ) {
    markInitialized(live);
    if (stringField(rec, "subtype") === "init") noteClaudeTurnStarted(live);
  }

  if (live.manualCompaction && type !== "system" && type !== "result") {
    return;
  }

  if (noteGoal(sessionId, live, rec)) return;
  if (handleAgentLifecycle(live, rec)) return;
  if (type === "tool_progress") {
    handleToolProgress(live, rec);
    return;
  }
  if (type === "stream_event") {
    if (!isSubagentMessage(rec)) noteClaudeTurnStarted(live);
    handleStreamEvent(live, rec);
    return;
  }
  if (type === "assistant") {
    if (!isSubagentMessage(rec)) noteClaudeTurnStarted(live);
    handleAssistant(live, rec);
    return;
  }
  if (type === "user") {
    handleUser(live, rec);
    return;
  }
  if (type === "result") {
    handleResult(live, rec);
    return;
  }
  if (type === "rate_limit_event") {
    live.usageLimit = usageLimitFromRateLimitEvent(rec);
    return;
  }
  if (type === "system") {
    const retry = claudeRetryFromMessage(rec);
    if (retry) {
      live.onEvent(retry);
      return;
    }
    const notice = noticeFromSystem(rec);
    if (notice) {
      live.onEvent({ type: "notice", ...notice });
      return;
    }
    const text = statusTextFromSystem(rec);
    if (text) {
      if ((stringField(rec, "subtype") ?? "").startsWith("compact")) {
        live.compactionConfirmed = true;
      }
      live.onEvent({ type: "status", text });
    }
  }
}

function handleStreamEvent(live: Live, rec: Record<string, unknown>): void {
  const subagent = isSubagentMessage(rec);
  const delta = streamDeltaFromEvent(rec);
  if (delta) {
    if (subagent) return;
    if (delta.kind === "assistant") {
      closePendingAssistantMessage(live);
      live.emittedAssistant = joinStreamText(live.emittedAssistant, delta.text);
      live.onEvent({ type: "message.delta", text: delta.text });
    } else {
      live.emittedReasoning = joinStreamText(live.emittedReasoning, delta.text);
      live.onEvent({ type: "reasoning.delta", text: delta.text });
    }
    return;
  }

  const started = toolStartFromEvent(rec);
  if (started) {
    if (subagent) {
      noteSubagentTool(live, rec, started.id, started.name, started.input);
      return;
    }
    const tool: InFlightTool = {
      id: started.id,
      name: started.name,
      input: started.input,
      partialJson: "",
      title: toolTitle(started.name, started.input),
    };
    if (started.index >= 0) live.toolsByIndex.set(started.index, tool);
    live.toolsById.set(started.id, tool);
    live.onEvent({
      type: "tool.started",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      ...(isAgentToolName(tool.name) && stringField(tool.input, "model")
        ? { agentModel: stringField(tool.input, "model") }
        : {}),
      status: isAgentToolName(tool.name) ? "in_progress" : "pending",
      preview: previewFromTool(tool.name, tool.input),
      ...shellCommand(tool.name, tool.input),
    });
    emitTaskListIfNeeded(live, tool.name, tool.input);
    return;
  }

  const jsonDelta = inputJsonDeltaFromEvent(rec);
  if (jsonDelta) {
    if (subagent) return;
    const tool = live.toolsByIndex.get(jsonDelta.index);
    if (!tool) return;
    tool.partialJson += jsonDelta.partial;
    const parsed = tryParseJsonRecord(tool.partialJson);
    if (!parsed) return;
    tool.input = parsed;
    tool.title = toolTitle(tool.name, parsed);
    live.onEvent({
      type: "tool.updated",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      ...(isAgentToolName(tool.name) && stringField(tool.input, "model")
        ? { agentModel: stringField(tool.input, "model") }
        : {}),
      status: "pending",
      detail: summarizeToolRequest(tool.name, parsed),
      preview: previewFromTool(tool.name, parsed),
      ...shellCommand(tool.name, parsed),
    });
    emitTaskListIfNeeded(live, tool.name, parsed);
    return;
  }
}

/**
 * Tell the session the provider's own context window, before the turn's `result` arrives.
 *
 * Mid-turn Claude Code reports only the level; the window comes on the `result` at the end. The context meter
 * draws a ring only when it has both, so without this a routed session shows no bar while it is working, and a
 * session whose last turn was cut short (a quit) keeps a stale level forever. The Rust side remembers the
 * window per route, so this is one provider call per model per run. A provider that publishes no window leaves
 * it unknown — a guessed window is worse than none.
 *
 * Fire-and-forget: a failed lookup must never hold up or fail the turn.
 */
function seedRoutedWindow(
  live: Live,
  input: Pick<HarnessSessionInput, "model" | "modelSettings">,
): void {
  const route = customModelRoute({ model: input.model, modelSettings: input.modelSettings ?? {} });
  const window = modelKeyStore().contextWindow;
  if (!route || !window) return;
  void Promise.resolve(
    window(route.provider, route.baseUrl, route.modelId, route.customModelId),
  )
    .then((found) => {
      if (typeof found === "number" && found > 0) {
        live.onEvent({ type: "context", window: found });
      }
    })
    .catch(() => undefined);
}

function handleAssistant(live: Live, rec: Record<string, unknown>): void {
  if (isSubagentMessage(rec)) {
    noteSubagentNarration(live, rec);
    for (const use of assistantToolUses(rec)) {
      noteSubagentTool(live, rec, use.id, use.name, use.input);
    }
    return;
  }

  live.assistantError = stringField(rec, "error");
  const used = contextUsedFromAssistant(rec);
  if (used !== undefined) {
    live.contextUsed = used;
    live.onEvent({ type: "context", used });
  }

  const snapshot = assistantTextBlocks(rec).join("");
  if (snapshot) closePendingAssistantMessage(live);
  const extra = snapshotRemainder(live.emittedAssistant, snapshot);
  if (extra) {
    live.emittedAssistant = joinStreamText(live.emittedAssistant, extra);
    live.onEvent({ type: "message.delta", text: extra });
  }

  for (const use of assistantToolUses(rec)) {
    const streamed = live.toolsById.get(use.id);
    if (streamed) {
      // content_block_start often has an empty input. The input JSON delta may
      // never form a parseable object before the complete assistant snapshot.
      // Reconcile that snapshot instead of leaving the tool labelled "Shell".
      if (JSON.stringify(streamed.input) !== JSON.stringify(use.input)) {
        streamed.input = use.input;
        streamed.title = toolTitle(use.name, use.input);
        live.onEvent({
          type: "tool.updated",
          callId: streamed.id,
          title: streamed.title,
          kind: toolKindFromName(streamed.name),
          ...(isAgentToolName(streamed.name) && stringField(use.input, "model")
            ? { agentModel: stringField(use.input, "model") }
            : {}),
          status: isAgentToolName(streamed.name) ? "in_progress" : "pending",
          preview: previewFromTool(streamed.name, use.input),
          ...shellCommand(streamed.name, use.input),
        });
        emitTaskListIfNeeded(live, streamed.name, use.input);
      }
      if (use.name === "ExitPlanMode") {
        const plan = extractExitPlanModePlan(use.input);
        if (plan) live.onEvent({ type: "plan", text: plan });
      }
      continue;
    }
    const tool: InFlightTool = {
      id: use.id,
      name: use.name,
      input: use.input,
      partialJson: "",
      title: toolTitle(use.name, use.input),
    };
    live.toolsById.set(use.id, tool);
    live.onEvent({
      type: "tool.started",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      ...(isAgentToolName(tool.name) && stringField(tool.input, "model")
        ? { agentModel: stringField(tool.input, "model") }
        : {}),
      status: isAgentToolName(tool.name) ? "in_progress" : "pending",
      preview: previewFromTool(tool.name, tool.input),
      ...shellCommand(tool.name, tool.input),
    });
    if (use.name === "ExitPlanMode") {
      const plan = extractExitPlanModePlan(use.input);
      if (plan) live.onEvent({ type: "plan", text: plan });
    }
    emitTaskListIfNeeded(live, tool.name, tool.input);
  }

  // Claude Code writes one record per content block, so a tool record follows
  // the text of the same message and has no text of its own. It must not clear
  // the boundary the text set, or message.completed never fires before the next
  // message and the two run together ("rest.Six"). A later record may only set it.
  if (snapshot || live.emittedAssistant) live.pendingAssistantBoundary = true;
  live.emittedAssistant = "";
  live.emittedReasoning = "";
}

function closePendingAssistantMessage(live: Live): void {
  if (!live.pendingAssistantBoundary) return;
  live.pendingAssistantBoundary = false;
  live.onEvent({ type: "message.completed" });
}

function handleUser(live: Live, rec: Record<string, unknown>): void {
  if (isSubagentMessage(rec)) {
    noteSubagentResults(live, rec);
    return;
  }
  for (const result of toolResultsFromUserMessage(rec)) {
    const tool = live.toolsById.get(result.toolUseId);
    if (!tool) continue;
    if (isAgentToolName(tool.name) && isBackgroundedAgentTool(live, tool.id)) {
      continue;
    }
    // The Workflow tool answers at once that the run went to the background;
    // the run, not that answer, decides when its row is done.
    if (
      isClaudeWorkflowTool(tool.name) &&
      !result.isError &&
      (isWorkflowLaunchAck(result.text) || workflowForCall(live, tool.id))
    ) {
      continue;
    }
    live.onEvent({
      type: "tool.updated",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      status: result.isError ? "failed" : "completed",
      detail: result.text || undefined,
      preview: previewFromTool(tool.name, tool.input, result.text),
    });
    if (
      !result.isError &&
      applyClaudeTaskTool(live.claudeTasks, tool.name, tool.input, result.text)
    ) {
      live.onEvent({
        type: "tasks.updated",
        key: CLAUDE_TASKS_KEY,
        // The map is the source of truth, so a TaskUpdate subject is a rename.
        authoritative: true,
        providerSessionId: live.claudeSessionId,
        items: [...live.claudeTasks.values()],
      });
    }
    // What a subagent hands back is the last thing it said, so it closes out
    // that agent's own trail rather than sitting on the parent row as detail.
    if (isAgentToolName(tool.name) && result.text.trim() && !result.isError) {
      live.onEvent({
        type: "agent.step",
        callId: tool.id,
        stepId: `${tool.id}:report`,
        kind: "message",
        text: result.text,
      });
    }
    if (isAgentToolName(tool.name)) {
      tool.settled = true;
      settleInlineAgentTask(live, tool.id);
    }
  }
}

/**
 * A subagent that was never backgrounded reports back on the parent's own tool
 * result, and Claude sends no task record for one that ended inline. Without
 * this its task would keep the turn open for good: the reply reads as finished
 * while the composer and the plan's Build button stay disabled until a restart.
 */
function settleInlineAgentTask(live: Live, toolUseId: string): void {
  let settled = false;
  for (const [taskId, task] of [...live.agentTasks]) {
    if (task.toolUseId !== toolUseId || task.backgrounded) continue;
    live.agentTasks.delete(taskId);
    live.backgroundTasks.delete(taskId);
    settled = true;
  }
  if (!settled) return;
  maybeFinishTurn(live);
  syncBackgroundWait(live);
}

function handleResult(live: Live, rec: Record<string, unknown>): void {
  if (isSubagentMessage(rec)) return;
  if (isReplayedTaskNotificationResult(rec)) {
    // A limit reported for the replay must not carry over to the real turn.
    live.usageLimit = null;
    live.assistantError = undefined;
    return;
  }
  // A /compact result reports the summarizer call's usage, not the rebuilt
  // conversation level. The next real turn will provide the fresh reading.
  // A confirmed compaction leaves a small context; its own result reports
  // the summarizer's usage, not that level.
  if (live.manualCompaction && live.compactionConfirmed) live.contextUsed = 0;
  if (!live.manualCompaction) {
    const context = contextFromResult(rec);
    if (context) live.onEvent({ type: "context", ...context });
    if (context?.used !== undefined) live.contextUsed = context.used;
  }
  // When this conversation last used its cache and how long that lives, so a
  // message after a long idle can compact first (see compactIfIdle).
  rememberPromptCache(live.threadId, {
    providerSessionId: live.claudeSessionId,
    lastTurnAt: Date.now(),
    cacheTtlMs: promptCacheTtlFromUsage(rec.usage),
    contextUsed: live.contextUsed,
    // A real turn gives a chat that stopped compacting in the background another chance.
    compactFailures: live.manualCompaction ? undefined : 0,
  });
  const metrics = turnMetricsFromResult(rec);
  if (metrics?.costUsd != null) {
    const total = metrics.costUsd;
    // A total below the last one means the counter started over; take it as it stands.
    const previous = live.lastTotalCostUsd ?? 0;
    metrics.costUsd = total >= previous ? total - previous : total;
    live.lastTotalCostUsd = total;
  }
  if (metrics) live.onEvent({ type: "turn.metrics", ...metrics });
  // WP-176: the per-task ceiling sees this turn's own cost. A project limit does not stop the run.
  const ceilingStop = noteBilledCeiling(live, metrics);
  if (!live.manualCompaction) noteDroppedEffort(live);

  // Claude Code reports a refused API request as a "success" with is_error:
  // the class says why, so a worker refused for billing is never "completed".
  const result = turnStatusFromResult(rec, {
    usageLimit: live.usageLimit,
    assistantError: live.assistantError,
  });
  live.usageLimit = null;
  live.assistantError = undefined;
  const failure = result.failure;
  if (result.status === "failed" && !live.cancelled && !live.quietCompaction) {
    live.onEvent({
      type: "session.error",
      message: result.error ?? "Claude turn failed.",
      ...(failure
        ? {
            errorClass: failure.errorClass,
            retryable: failure.retryable,
            ...(failure.resetsAt != null ? { resetsAt: failure.resetsAt } : {}),
          }
        : {}),
    });
    // A refused window can still fall back to another model, so only a turn
    // that failed on it was stopped by it. Only a usage limit lifts by
    // itself: a 401 or a 402 must never arm a resume at reset.
    if (failure?.errorClass === "usage_limit") {
      live.onEvent({
        type: "usage.limited",
        ...(failure.resetsAt != null ? { resetsAt: failure.resetsAt } : {}),
      });
    }
  }
  // A wake's result answers the wake, not a prompt this turn wrote (recorded in T3 Code's
  // claude_background_wake_before_queued_prompt*: the prompt's own work comes after it).
  if (!isWakeResult(rec)) live.promptsOwed = Math.max(0, live.promptsOwed - 1);
  live.turnResultSeen = true;
  holdForOwedPrompt(live);
  maybeFinishTurn(live);
  // Stop only this run, and only after the turn promise can settle. Mute comes second.
  if (ceilingStop) void cancelClaudeTurn(live.threadId);
  showBackgroundRows(live);
  syncBackgroundWait(live);
}

/** Ask once near a billed ceiling. A hard cap stops this run and no other. */
function noteBilledCeiling(live: Live, metrics: { costUsd?: number } | undefined): boolean {
  const verdict = reviewReportedTurn({
    sessionId: live.threadId,
    cwd: live.cwd,
    model: live.target?.model,
    harness: "claude",
    metrics: metrics ?? null,
    unattended: live.threadId.startsWith("app-"),
  });
  if (verdict.ask && verdict.reason.trim()) {
    live.onEvent({ type: "status", text: verdict.reason.trim() });
  }
  if (!verdict.stopRun) return false;
  const reason = verdict.reason.trim();
  if (reason) live.onEvent({ type: "session.error", message: reason });
  return true;
}

async function handleControlRequest(
  sessionId: string,
  live: Live,
  control: ClaudeControlRequest,
): Promise<void> {
  if (control.subtype !== "can_use_tool" && control.subtype !== "permission") {
    await writeJson(sessionId, buildControlResponse(control.requestId, {}));
    return;
  }

  const toolName = control.toolName ?? "tool";
  const input = control.input ?? {};

  if (live.cancelled || live.muteUpdates) {
    await writeJson(
      sessionId,
      buildControlResponse(
        control.requestId,
        toClaudePermissionResult("deny", input),
      ),
    ).catch(() => undefined);
    return;
  }

  if (toolName === "AskUserQuestion") {
    const questions = questionsFromUnknown(input);
    const uiId = live.nextApprovalUiId++;
    const pending = waitQuestion(live, uiId, control.requestId, {
      type: "question.asked",
      requestId: uiId,
      title:
        questionPromptTitle(questions) || extractAskUserQuestionTitle(input),
      questions,
      callId: control.toolUseId,
    });
    showNextQuestion(live);
    const outcome = await pending;
    const decision =
      outcome === "cancelled"
        ? "cancelled"
        : outcome.kind === "answered"
          ? "answered"
          : "skipped";
    live.onEvent({ type: "question.resolved", requestId: uiId, decision });
    showNextQuestion(live);
    if (outcome === "cancelled") return;
    const response =
      outcome.kind === "answered"
        ? {
            behavior: "allow",
            updatedInput: askUserQuestionAllowInput(input, outcome),
          }
        : {
            behavior: "deny",
            message: "User cancelled tool execution.",
          };
    await writeJson(
      sessionId,
      buildControlResponse(control.requestId, response),
    );
    return;
  }

  if (toolName === "ExitPlanMode") {
    const plan = extractExitPlanModePlan(input);
    if (plan) live.onEvent({ type: "plan", text: plan });
    await writeJson(
      sessionId,
      buildControlResponse(control.requestId, {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
      }),
    );
    return;
  }

  applyKnownToolInput(live, toolName, input, control.toolUseId);

  // r65 (#13): a keychain or credential read is refused in code before any mode can allow it, with a message that sends
  // the agent to ask Ash instead of retrying.
  const blocked = credentialBlock(approvalCall(toolName, input), live.cwd);
  if (blocked) {
    await writeJson(sessionId, buildControlResponse(control.requestId, { behavior: "deny", message: blocked }));
    return;
  }

  if (live.planning) {
    const kind = toolKindFromName(toolName);
    const decision = kind === "read" || kind === "search" ? "allow" : "deny";
    await writeJson(
      sessionId,
      buildControlResponse(
        control.requestId,
        toClaudePermissionResult(decision, input),
      ),
    );
    return;
  }

  if (live.runtimeMode === "full-access") {
    await writeJson(
      sessionId,
      buildControlResponse(
        control.requestId,
        toClaudePermissionResult("allow", input),
      ),
    );
    return;
  }

  const uiId = live.nextApprovalUiId++;
  // WP-122: a child's ask is answered on the parent, and the answer goes to the child port only.
  const child = childForAsk(live, control);
  if (child) {
    await answerChildClaudeApproval(live, uiId, control.requestId, control.toolUseId, toolName, input, child);
    return;
  }
  const pending = waitApproval(live, uiId, control.requestId, input);
  live.onEvent({
    type: "approval.requested",
    requestId: uiId,
    title: toolTitle(toolName, input),
    kind: toolKindFromName(toolName),
    callId: control.toolUseId,
    preview: previewFromTool(toolName, input),
    call: approvalCall(toolName, input),
  });
  const decision = await pending;
  live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
  if (decision === "cancelled") return;
  await writeJson(
    sessionId,
    buildControlResponse(
      control.requestId,
      toClaudePermissionResult(decision, input),
    ),
  );
}

function applyKnownToolInput(
  live: Live,
  toolName: string,
  input: Record<string, unknown>,
  callId?: string,
): void {
  if (!callId || Object.keys(input).length === 0) return;
  const existing = live.toolsById.get(callId);
  if (existing) {
    existing.input = input;
    existing.title = toolTitle(toolName, input);
  }
  live.onEvent({
    type: "tool.updated",
    callId,
    title: toolTitle(toolName, input),
    kind: toolKindFromName(toolName),
    status: "pending",
    preview: previewFromTool(toolName, input),
  });
}

function waitApproval(
  live: Live,
  uiId: number,
  requestId: string,
  input: Record<string, unknown>,
): Promise<ApprovalOutcome> {
  return new Promise<ApprovalOutcome>((resolve) => {
    live.approvals.set(uiId, { requestId, input, resolve });
  }).finally(() => {
    live.approvals.delete(uiId);
  });
}

/** What a subagent's ask is called when no child frame has told us who it is. */
const UNNAMED_CHILD = "a subagent";

/** A delegated run Claude has started and not yet heard back from, or a task still running in the background. */
function hasOpenDelegatedRun(live: Live): boolean {
  if (live.agentTasks.size > 0) return true;
  for (const tool of live.toolsById.values()) {
    if (isAgentToolName(tool.name) && !tool.settled) return true;
  }
  return false;
}

/**
 * The child an ask belongs to, or nothing when it is the parent's own.
 *
 * A call the child already made names its child. Claude announces the parent's own calls before it asks about
 * them, so an ask for a call nobody announced (or one that names no call) while a delegated run is open is a
 * subagent's whose frame has not landed yet. It is shown as "a subagent" rather than as the parent's, and is
 * answered on its own request id like any other.
 */
function childForAsk(
  live: Live,
  control: ClaudeControlRequest,
): { name: string; sessionPort: string } | undefined {
  const id = control.toolUseId?.trim();
  const known = id ? live.childTools.get(id) : undefined;
  if (known) return known;
  if ((id && live.toolsById.has(id)) || !hasOpenDelegatedRun(live)) return undefined;
  const sessionPort = (live.claudeSessionId || live.threadId).replace(/\r/g, "").trim();
  if (!sessionPort || /[\u0000-\u001f]/.test(sessionPort)) return undefined;
  ensureChildPort(live, sessionPort);
  return { name: UNNAMED_CHILD, sessionPort };
}

function rememberChildPort(live: Live, toolUseId: string, name: string, sessionPort: string): void {
  const id = toolUseId.trim();
  const port = sessionPort.replace(/\r/g, "").trim();
  if (!id || !port || /[\u0000-\u001f]/.test(port)) return;
  if (!live.childTools.has(id)) {
    live.childTools.set(id, { name: name.trim() || "Subagent", sessionPort: port });
  }
  ensureChildPort(live, port);
}

function ensureChildPort(live: Live, port: string): void {
  if (live.childPorts.has(port)) return;
  live.childPorts.set(port, {
    id: port,
    // A failed write rejects, as it does for the parent's own answer, so the turn fails instead of
    // showing an answer Claude never got.
    write: (answer) => {
      const input = live.childInputs.get(answer.requestId) ?? {};
      return writeJson(
        live.threadId,
        buildControlResponse(answer.requestId, toClaudePermissionResult(answer.decision, input)),
      );
    },
  });
}

async function answerChildClaudeApproval(
  live: Live,
  uiId: number,
  requestId: string,
  toolUseId: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
  child: { name: string; sessionPort: string },
): Promise<void> {
  live.childInputs.set(requestId, input);
  const title = toolTitle(toolName, input);
  let pending = waitApproval(live, uiId, requestId, input);
  live.onEvent({
    type: "approval.requested",
    requestId: uiId,
    title,
    kind: toolKindFromName(toolName),
    callId: toolUseId,
    preview: previewFromTool(toolName, input),
    call: approvalCall(toolName, input),
    child: { name: child.name, sessionPort: child.sessionPort, detail: title },
  });
  try {
    for (;;) {
      const decision = await pending;
      if (decision === "cancelled") {
        live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
        return;
      }
      const sent = await forwardChildAnswer(
        { requestId, sessionPort: child.sessionPort },
        decision,
        live.childPorts,
      );
      if (sent === "sent" || live.muteUpdates || live.cancelled) {
        live.onEvent({ type: "approval.resolved", requestId: uiId, decision });
        return;
      }
      live.onEvent({
        type: "status",
        text: "The subagent is not reachable, so the answer was not sent.",
      });
      pending = waitApproval(live, uiId, requestId, input);
    }
  } finally {
    live.childInputs.delete(requestId);
  }
}

function waitQuestion(
  live: Live,
  uiId: number,
  requestId: string,
  event: Extract<HarnessEvent, { type: "question.asked" }>,
): Promise<UserQuestionReply | "cancelled"> {
  return new Promise<UserQuestionReply | "cancelled">((resolve) => {
    live.questions.set(uiId, { requestId, event, resolve });
  }).finally(() => {
    live.questions.delete(uiId);
  });
}

function showNextQuestion(live: Live): void {
  if (live.muteUpdates || live.cancelled) return;
  if (
    live.visibleQuestionId !== null &&
    live.questions.has(live.visibleQuestionId)
  )
    return;
  const next = live.questions.entries().next().value;
  live.visibleQuestionId = next?.[0] ?? null;
  if (next) live.onEvent(next[1].event);
}

function emitTaskListIfNeeded(
  live: Live,
  toolName: string,
  input: Record<string, unknown>,
): void {
  if (!isTodoTool(toolName)) return;
  const items = taskListFromTodos(input);
  if (items) live.onEvent({ type: "tasks.updated", items });
}

function handleAgentLifecycle(
  live: Live,
  rec: Record<string, unknown>,
): boolean {
  const started = parseTaskStarted(rec);
  if (started) {
    if (started.ambient) return true;
    live.backgroundTasks.set(started.taskId, {
      description: started.description,
      toolUseId: started.toolUseId,
      kind: cutWorkKind(started.taskType),
    });
    syncBackgroundWait(live);
    if (isClaudeWorkflowTaskType(started.taskType)) {
      const run = startWorkflowRun(rec, Date.now());
      if (run) {
        trackWorkflow(
          live,
          started.toolUseId ?? `workflow:${started.taskId}`,
          run,
        );
      }
      return true;
    }
    if (!isAgentTaskType(started.taskType)) return true;
    live.agentTasks.set(started.taskId, {
      taskId: started.taskId,
      toolUseId: started.toolUseId,
      description: started.description,
      backgrounded: started.backgrounded,
    });
    upsertAgentTool(
      live,
      started.toolUseId,
      started.description,
      "in_progress",
    );
    return true;
  }

  const progress = parseTaskProgress(rec);
  if (progress) {
    const workflow = live.workflows.get(progress.taskId);
    if (workflow) {
      const next = applyWorkflowProgress(workflow.run, rec, Date.now());
      if (next) trackWorkflow(live, workflow.callId, next);
      return true;
    }
    // A run whose start this process never saw (a resumed conversation):
    // its own frame says it is a workflow.
    if (workflowFrame(rec)) {
      const run = startWorkflowRun(rec, Date.now());
      const next = run && applyWorkflowProgress(run, rec, Date.now());
      if (next) {
        // Tracked like a run whose start was seen, so its Stop (and the
        // turn's) reaches it and the turn waits for it to end.
        if (!live.backgroundTasks.has(progress.taskId)) {
          live.backgroundTasks.set(progress.taskId, {
            description: progress.description || "Workflow",
            toolUseId: progress.toolUseId,
            kind: cutWorkKind(CLAUDE_WORKFLOW_TASK_TYPE),
          });
          syncBackgroundWait(live);
        }
        trackWorkflow(
          live,
          progress.toolUseId ?? `workflow:${progress.taskId}`,
          next,
        );
      }
      return true;
    }
    const task = live.agentTasks.get(progress.taskId);
    const title = progress.description || task?.description || "Subagent";
    const detail =
      progress.summary ||
      progress.lastToolName ||
      (progress.subagentType
        ? `${progress.subagentType.replace(/[_-]+/g, " ")} subagent`
        : undefined);
    upsertAgentTool(
      live,
      progress.toolUseId ?? task?.toolUseId,
      title,
      "in_progress",
      detail,
    );
    return true;
  }

  const updated = parseTaskUpdated(rec);
  if (updated) {
    const task = live.agentTasks.get(updated.taskId);
    if (task && updated.backgrounded !== undefined) {
      task.backgrounded = updated.backgrounded;
    }
    if (task && updated.description) task.description = updated.description;
    const background = live.backgroundTasks.get(updated.taskId);
    if (background && updated.description) {
      background.description = updated.description;
    }
    if (isTerminalAgentTaskStatus(updated.status)) {
      endWorkflow(live, updated.taskId, workflowEndStatus(updated.status));
      settleBackgroundRow(
        live,
        updated.taskId,
        updated.status ?? "completed",
        updated.error,
      );
      finishBackgroundTask(live, updated.taskId);
      completeAgentTask(
        live,
        updated.taskId,
        updated.status === "completed" ? "completed" : "failed",
        updated.error,
      );
    }
    return true;
  }

  const notice = parseTaskNotification(rec);
  if (notice) {
    if (!notice.ambient) {
      endWorkflow(
        live,
        notice.taskId,
        workflowEndStatus(notice.status),
        notice.summary || undefined,
      );
      noteTaskNotification(live, notice);
      finishBackgroundTask(live, notice.taskId);
      completeAgentTask(
        live,
        notice.taskId,
        notice.status === "completed" ? "completed" : "failed",
        notice.summary || undefined,
      );
    }
    return true;
  }

  const allTasks = parseBackgroundTasks(rec);
  if (!allTasks) return false;
  const next = new Set(allTasks.map((task) => task.taskId));
  for (const id of [...live.backgroundTasks.keys()]) {
    if (next.has(id)) continue;
    endWorkflow(live, id, "completed");
    settleBackgroundRow(live, id, "completed");
    finishBackgroundTask(live, id);
  }
  for (const row of allTasks) {
    if (!live.backgroundTasks.has(row.taskId)) {
      live.backgroundTasks.set(row.taskId, {
        description: row.description,
        kind: cutWorkKind(row.taskType),
      });
    }
  }
  const liveTasks = allTasks.filter((task) => isAgentTaskType(task.taskType));
  for (const id of [...live.agentTasks.keys()]) {
    if (!next.has(id)) completeAgentTask(live, id, "completed");
  }
  for (const row of liveTasks) {
    if (live.agentTasks.has(row.taskId)) continue;
    // The list carries no tool_use_id and often lands before task_started, so
    // find the Agent call that spawned it rather than opening a second row.
    const toolUseId = unclaimedAgentCall(live, row.description);
    live.agentTasks.set(row.taskId, {
      taskId: row.taskId,
      toolUseId,
      description: row.description,
      backgrounded: true,
    });
    upsertAgentTool(live, toolUseId, row.description, "in_progress");
  }
  maybeFinishTurn(live);
  syncBackgroundWait(live);
  return true;
}

/** Keep the run and tell the transcript; its row hangs off `callId`. */
function trackWorkflow(
  live: Live,
  callId: string,
  run: WorkflowRunMeta,
): void {
  live.workflows.set(run.taskId, { callId, run });
  if (live.muteUpdates) return;
  live.onEvent({ type: "workflow.progress", callId, run });
}

/**
 * End a run once. `task_updated` usually ends it first; the notification that
 * follows only adds what the CLI said about it.
 */
function endWorkflow(
  live: Live,
  taskId: string,
  status: WorkflowRunStatus,
  summary?: string,
): void {
  const workflow = live.workflows.get(taskId);
  if (!workflow) return;
  if (workflow.run.status !== "running") {
    if (summary && !workflow.run.summary) {
      trackWorkflow(live, workflow.callId, { ...workflow.run, summary });
    }
    return;
  }
  trackWorkflow(
    live,
    workflow.callId,
    endWorkflowRun(workflow.run, status, Date.now(), summary),
  );
}

function settleWorkflows(live: Live, status: WorkflowRunStatus): void {
  for (const taskId of [...live.workflows.keys()]) {
    endWorkflow(live, taskId, status);
  }
}

function workflowForCall(
  live: Live,
  callId: string,
): LiveWorkflow | undefined {
  for (const workflow of live.workflows.values()) {
    if (workflow.callId === callId) return workflow;
  }
  return undefined;
}

/**
 * Stop one background task Claude runs for this session: a whole workflow
 * run, with every agent in it. False when no live process has that task.
 */
export async function stopClaudeTask(
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  const live = liveByThread.get(sessionId);
  if (!live || !live.backgroundTasks.has(taskId)) return false;
  await writeJson(
    sessionId,
    buildControlRequest(nextControlId(live), {
      subtype: "stop_task",
      task_id: taskId,
    }),
  );
  return true;
}

/** The command a Bash call runs, for the tool event (the live step line names it in coding chats). */
function shellCommand(name: string, input: Record<string, unknown>): { command?: string } {
  if (name !== "Bash") return {};
  const command = stringField(input, "command")?.trim();
  return command ? { command } : {};
}

function handleToolProgress(live: Live, rec: Record<string, unknown>): void {
  const progress = parseToolProgress(rec);
  if (!progress) return;
  const tool =
    live.toolsById.get(progress.toolUseId) ??
    (progress.parentToolUseId
      ? live.toolsById.get(progress.parentToolUseId)
      : undefined);
  if (!tool) return;
  // A plain call (a Bash build, a long read) that Claude Code says still runs: a heartbeat for the live step line.
  if (!isAgentToolName(tool.name)) {
    live.onEvent({
      type: "tool.progress",
      callId: tool.id,
      ...(progress.elapsedMs !== undefined ? { elapsedMs: progress.elapsedMs } : {}),
    });
    return;
  }
  live.onEvent({
    type: "tool.updated",
    callId: tool.id,
    title: tool.title,
    kind: "agent",
    status: "in_progress",
  });
  // Progress names the call in flight. That is a step in the run, not the
  // result of it, so it goes to the panel rather than onto the Agent row.
  if (progress.toolName) {
    live.onEvent({
      type: "agent.step",
      callId: tool.id,
      stepId: progress.toolUseId,
      kind: "tool",
      text: progress.toolName,
      status: "in_progress",
      ...(progress.subagentType ? { agentType: progress.subagentType } : {}),
    });
  }
}

/**
 * The Agent call a subagent message belongs to, or nothing when the message
 * came from somewhere the parent transcript has no row for.
 */
function subagentParent(
  live: Live,
  rec: Record<string, unknown>,
): InFlightTool | undefined {
  const parentId = stringField(rec, "parent_tool_use_id");
  if (!parentId) return undefined;
  const parent = live.toolsById.get(parentId);
  if (!parent || !isAgentToolName(parent.name)) return undefined;
  return parent;
}

/**
 * A call a subagent made, mirrored onto the Agent row that spawned it. The
 * parent keeps its own "still running" status; the step is what the panel
 * under that row reads back.
 */
function noteSubagentTool(
  live: Live,
  rec: Record<string, unknown>,
  id: string,
  name: string,
  input: Record<string, unknown>,
): void {
  const parent = subagentParent(live, rec);
  if (!parent) return;
  const title = toolTitle(name, input);
  // No detail: the Agent row's detail is the report the run hands back, and
  // writing the call of the moment there would leave whatever the subagent
  // happened to do last standing in as its result.
  live.onEvent({
    type: "tool.updated",
    callId: parent.id,
    title: parent.title,
    kind: "agent",
    status: "in_progress",
  });
  if (!id) return;
  const sessionPort = stringField(rec, "session_id");
  if (sessionPort) rememberChildPort(live, id, parent.title || "Subagent", sessionPort);
  const preview = previewFromTool(name, input);
  live.onEvent({
    type: "agent.step",
    callId: parent.id,
    stepId: id,
    kind: "tool",
    text: title,
    toolKind: toolKindFromName(name),
    status: "in_progress",
    ...(preview ? { preview } : {}),
  });
}

/**
 * What a subagent said and thought on its way through the work. Its prose
 * never joins the parent transcript — that would read as the main agent
 * talking — but it is the most legible thing in the panel for its own row.
 */
function noteSubagentNarration(live: Live, rec: Record<string, unknown>): void {
  const parent = subagentParent(live, rec);
  if (!parent) return;
  const model = stringField(asRecord(rec.message), "model");
  if (model)
    live.onEvent({
      type: "tool.updated",
      callId: parent.id,
      kind: "agent",
      agentModel: model,
    });
  const messageId = assistantMessageId(rec) ?? crypto.randomUUID();
  const thinking = assistantThinkingBlocks(rec).join("").trim();
  if (thinking) {
    live.onEvent({
      type: "agent.step",
      callId: parent.id,
      stepId: `${messageId}:thinking`,
      kind: "reasoning",
      text: thinking,
    });
  }
  const text = assistantTextBlocks(rec).join("").trim();
  if (text) {
    live.onEvent({
      type: "agent.step",
      callId: parent.id,
      stepId: `${messageId}:text`,
      kind: "message",
      text,
    });
  }
}

/** Settles the subagent's own tool rows once their results come back. */
function noteSubagentResults(live: Live, rec: Record<string, unknown>): void {
  const parent = subagentParent(live, rec);
  if (!parent) return;
  for (const result of toolResultsFromUserMessage(rec)) {
    live.onEvent({
      type: "agent.step",
      callId: parent.id,
      stepId: result.toolUseId,
      kind: "tool",
      text: "",
      status: result.isError ? "failed" : "completed",
      ...(result.isError && result.text ? { detail: result.text } : {}),
    });
  }
}

function isBackgroundedAgentTool(live: Live, toolUseId: string): boolean {
  for (const task of live.agentTasks.values()) {
    if (task.toolUseId === toolUseId && task.backgrounded) return true;
  }
  return false;
}

/** The latest Agent call with this description that no task has claimed yet. */
function unclaimedAgentCall(
  live: Live,
  description: string,
): string | undefined {
  const claimed = new Set(
    [...live.agentTasks.values()].map((task) => task.toolUseId),
  );
  let match: string | undefined;
  for (const tool of live.toolsById.values()) {
    if (!isAgentToolName(tool.name) || claimed.has(tool.id)) continue;
    if (stringField(tool.input, "description") === description) match = tool.id;
  }
  return match;
}

function upsertAgentTool(
  live: Live,
  callId: string | undefined,
  title: string,
  status: string,
  detail?: string,
): void {
  const id = callId ?? `agent:${title}`;
  const existing = live.toolsById.get(id);
  if (!existing) {
    live.toolsById.set(id, {
      id,
      name: "Agent",
      input: {},
      partialJson: "",
      title,
    });
    live.onEvent({
      type: "tool.started",
      callId: id,
      title,
      kind: "agent",
      status,
    });
    if (
      status !== "in_progress" &&
      status !== "pending" &&
      status !== "running"
    ) {
      live.onEvent({
        type: "tool.updated",
        callId: id,
        title,
        kind: "agent",
        status,
        ...(detail ? { detail } : {}),
      });
    }
    return;
  }
  if (title) existing.title = title;
  live.onEvent({
    type: "tool.updated",
    callId: id,
    title: existing.title,
    kind: "agent",
    status,
    ...(detail ? { detail } : {}),
  });
}

function completeAgentTask(
  live: Live,
  taskId: string,
  status: string,
  detail?: string,
): void {
  const task = live.agentTasks.get(taskId);
  live.agentTasks.delete(taskId);
  if (task) {
    upsertAgentTool(
      live,
      task.toolUseId,
      task.description,
      status,
      detail ?? (status === "failed" ? "Subagent failed." : undefined),
    );
  }
  maybeFinishTurn(live);
}

/**
 * A task is done. If Claude had already yielded, the notification about it
 * starts a follow-up turn, so hold the MonoCode turn open for that too rather
 * than settling in the gap between the two.
 */
function finishBackgroundTask(live: Live, taskId: string): void {
  if (!live.backgroundTasks.delete(taskId)) return;
  if (live.turnResultSeen && live.activeTurn && !live.awaitingResume) {
    live.awaitingResume = setTimeout(() => {
      live.awaitingResume = null;
      maybeFinishTurn(live);
      syncBackgroundWait(live);
    }, RESUME_GRACE_MS);
  }
  maybeFinishTurn(live);
  syncBackgroundWait(live);
}

/**
 * Claude began another turn inside this MonoCode turn: woken by a finished
 * task, or by a follow-up written in while it waited. Its own result, not the
 * earlier one, decides when the MonoCode turn ends.
 */
function noteClaudeTurnStarted(live: Live): void {
  if (!live.activeTurn || !live.turnResultSeen) return;
  live.turnResultSeen = false;
  clearShellHold(live);
  // A new message, not more of the last one: its snapshot must not be
  // compared against what the earlier turn streamed.
  live.emittedAssistant = "";
  live.emittedReasoning = "";
  live.pendingAssistantBoundary = false;
  // Close the message Claude left off with, so the reply starts its own and
  // the fold puts the earlier one away, the same as prose between tool calls.
  // A background command's row already sits between the two; a subagent's
  // report is noted in the trail to do the same.
  live.onEvent({ type: "message.completed" });
  live.onEvent({ type: "reasoning.completed" });
  for (const text of live.taskNotes) live.onEvent({ type: "status", text });
  live.taskNotes = [];
  clearAwaitingResume(live);
  syncBackgroundWait(live);
}

/**
 * Claude yielded with commands still running. Each gets a live row under the
 * message it left off with, like any call in flight, until it finishes.
 * Subagents already have a row of their own.
 */
function showBackgroundRows(live: Live): void {
  if (!live.activeTurn || live.cancelled) return;
  for (const [taskId, task] of live.backgroundTasks) {
    if (
      live.backgroundRows.has(taskId) ||
      live.agentTasks.has(taskId) ||
      live.workflows.has(taskId)
    )
      continue;
    const source = task.toolUseId
      ? live.toolsById.get(task.toolUseId)
      : undefined;
    // Subagents and workflow runs already have a row of their own.
    if (
      source &&
      (isAgentToolName(source.name) || isClaudeWorkflowTool(source.name))
    )
      continue;
    const callId = `background:${taskId}`;
    live.backgroundRows.set(taskId, callId);
    live.onEvent({
      type: "tool.started",
      callId,
      title: source ? toolTitle(source.name, source.input) : task.description,
      kind: source ? toolKindFromName(source.name) : "execute",
      status: "in_progress",
      background: true,
      ...(source
        ? { preview: previewFromTool(source.name, source.input) }
        : {}),
    });
  }
}

function settleBackgroundRow(
  live: Live,
  taskId: string,
  status: string,
  detail?: string,
): void {
  const callId = live.backgroundRows.get(taskId);
  if (!callId || live.muteUpdates) return;
  live.onEvent({
    type: "tool.updated",
    callId,
    status: status === "completed" ? "completed" : "failed",
    ...(detail ? { detail } : {}),
  });
}

/**
 * What Claude was told when a task finished. A command's row takes the
 * summary; a subagent's is kept for the trail until Claude picks back up.
 */
function noteTaskNotification(
  live: Live,
  notice: ClaudeAgentTaskNotification,
): void {
  if (!live.activeTurn) return;
  if (live.backgroundRows.has(notice.taskId)) {
    settleBackgroundRow(
      live,
      notice.taskId,
      notice.status,
      notice.summary || undefined,
    );
    return;
  }
  const tool = notice.toolUseId ? live.toolsById.get(notice.toolUseId) : null;
  const agent =
    (tool && isAgentToolName(tool.name)) || live.agentTasks.has(notice.taskId);
  if (!agent || !live.turnResultSeen) return;
  live.taskNotes.push(notice.summary || "Subagent finished.");
}

function clearAwaitingResume(live: Live): void {
  if (!live.awaitingResume) return;
  clearTimeout(live.awaitingResume);
  live.awaitingResume = null;
}

/**
 * Tells the UI what the turn is waiting on once Claude has yielded with work
 * still running, and clears it when Claude picks the thread back up.
 */
function syncBackgroundWait(live: Live): void {
  syncCutWork(live);
  const waiting =
    live.activeTurn && live.turnResultSeen && !live.cancelled
      ? [...live.backgroundTasks.values()].map((task) => task.description)
      : [];
  const key = waiting.join("\n");
  if (key === live.backgroundKey) return;
  live.backgroundKey = key;
  if (live.muteUpdates) return;
  live.onEvent({ type: "background.updated", tasks: waiting });
}

/**
 * Tells the UI everything still running in the background with its id, whether or not Claude has yielded: if the
 * app quits or crashes now, this is what the resumed turn hears was cut.
 */
function syncCutWork(live: Live): void {
  const work: CutWork[] =
    live.activeTurn && !live.cancelled
      ? [...live.backgroundTasks].map(([id, task]) => ({
          kind: task.kind,
          label: task.description,
          id,
        }))
      : [];
  const key = work.map((entry) => `${entry.kind}:${entry.id}:${entry.label}`).join("\n");
  if (key === live.cutWorkKey) return;
  live.cutWorkKey = key;
  // A stopped turn still clears its list: what Stop ended was not cut by a restart.
  if (live.muteUpdates && work.length) return;
  live.onEvent({ type: "background.work", work });
}

function maybeFinishTurn(live: Live): void {
  if (!live.turnResultSeen) return;
  if (live.agentTasks.size > 0) return;
  if (live.backgroundTasks.size > 0) {
    holdForShells(live);
    return;
  }
  if (live.awaitingResume) return;
  if (!live.activeTurn && !live.turnDone) return;
  finishActiveTurn(live, [
    { type: "message.completed" },
    { type: "reasoning.completed" },
  ]);
}

/** Only shells left running, and Claude has yielded: give them SHELL_HOLD_MS to wake Claude, then let the turn go. */
function onlyShellsLeft(live: Live): boolean {
  if (!live.activeTurn || !live.turnResultSeen || live.cancelled) return false;
  if (live.agentTasks.size > 0 || live.workflows.size > 0 || live.awaitingResume) return false;
  if (live.backgroundTasks.size === 0) return false;
  return [...live.backgroundTasks.values()].every((task) => task.kind === "shell");
}

function holdForShells(live: Live): void {
  if (live.shellHold || !onlyShellsLeft(live)) return;
  live.shellHold = setTimeout(() => {
    live.shellHold = null;
    if (!onlyShellsLeft(live)) return;
    finishActiveTurn(live, [
      { type: "message.completed" },
      { type: "reasoning.completed" },
    ]);
    syncBackgroundWait(live);
  }, SHELL_HOLD_MS);
}

function clearShellHold(live: Live): void {
  if (!live.shellHold) return;
  clearTimeout(live.shellHold);
  live.shellHold = null;
}

function finishActiveTurn(live: Live, extraEvents: HarnessEvent[] = []): void {
  clearAwaitingResume(live);
  clearShellHold(live);
  live.turnEndPending = false;
  live.activeTurn = false;
  syncCutWork(live);
  for (const event of extraEvents) live.onEvent(event);
  const done = live.turnDone;
  const failed = live.turnFailed;
  live.turnDone = null;
  live.turnFailed = null;
  if (done) {
    done();
    return;
  }
  if (!failed) live.turnEndPending = true;
}

function settlePendingTurn(live: Live): void {
  if (!live.turnEndPending || !live.turnDone) return;
  finishActiveTurn(live);
}

function markInitialized(live: Live): void {
  if (live.initialized) return;
  live.initialized = true;
  live.initDone?.();
  live.initDone = null;
}

function waitForInit(live: Live, timeoutMs: number): Promise<void> {
  if (live.initialized) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      live.initDone = null;
      resolve();
    }, timeoutMs);
    live.initDone = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function nextControlId(live: Live): string {
  live.nextControlId += 1;
  return `monocode_${live.nextControlId}`;
}

function writeJson(
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return writeChild(sessionId, JSON.stringify(payload));
}

/** What a process for this input would be started with. */
function claudeLaunchFor(input: HarnessSessionInput, append = mergeClaudeAppend(claudeAppend(input.sessionId), notedSessionAppend(input.sessionId))): ClaudeLaunch {
  const options = launchOptions(input);
  const route = customModelRoute({
    model: input.model,
    modelSettings: input.modelSettings ?? {},
  });
  return {
    model: options.model,
    ...(route
      ? {
          route: JSON.stringify([route.provider, route.baseUrl, route.modelId]),
          // The level the chat picked, not what is sent: a level the provider refused is dropped without a restart.
          routeEffort: pickedCustomEffort({ model: input.model, modelSettings: input.modelSettings ?? {} })?.effort,
        }
      : {}),
    effort: options.effort,
    permissionMode: options.permissionMode ?? "default",
    // Full access, even while in plan mode: leaving plan for it then applies live.
    allowBypass: input.runtimeMode === "full-access",
    thinking: options.settings?.alwaysThinkingEnabled === true,
    fast: options.settings?.fastMode === true,
    ultracode: options.settings?.ultracode === true,
    hooks: options.settings?.disableAllHooks !== true,
    autoCompactWindow: options.settings?.autoCompactWindow,
    ...(append ? { appendKey: append.key } : {}),
    ...(options.firstMate ? { firstMate: true } : {}),
  };
}

/**
 * Send each request and wait for its answer. False on the first refusal or
 * silence, so the caller falls back to a restart; whatever was applied before
 * it is replaced by the new process anyway.
 */
async function applyLiveRequests(
  sessionId: string,
  live: Live,
  requests: ClaudeLiveRequest[],
): Promise<boolean> {
  for (const { request } of requests) {
    const answer = await controlRoundTrip(sessionId, live, request);
    if (!answer?.ok) return false;
  }
  return true;
}

/** `set_model` checks the model with one request first, so allow for that. */
const LIVE_CONTROL_TIMEOUT_MS = 20_000;

function controlRoundTrip(
  sessionId: string,
  live: Live,
  request: Record<string, unknown>,
): Promise<ClaudeControlResponse | null> {
  const requestId = nextControlId(live);
  return new Promise<ClaudeControlResponse | null>((resolve) => {
    const timer = setTimeout(() => {
      live.pendingControls.delete(requestId);
      resolve(null);
    }, LIVE_CONTROL_TIMEOUT_MS);
    live.pendingControls.set(requestId, (answer) => {
      clearTimeout(timer);
      live.pendingControls.delete(requestId);
      resolve(answer);
    });
    writeJson(sessionId, buildControlRequest(requestId, request)).catch(() => {
      clearTimeout(timer);
      live.pendingControls.delete(requestId);
      resolve(null);
    });
  });
}

/** One quiet line saying what changed without a restart. */
function noteAppliedLive(
  live: Live,
  requests: ClaudeLiveRequest[],
  input: Pick<LiveSettingsInput, "model" | "runtimeMode">,
): void {
  const parts = requests.map(({ label, request }) => {
    if (request.subtype === "set_model") {
      return `model ${resolveModel("claude", input.model).name}`;
    }
    if (request.subtype === "set_permission_mode") {
      return request.mode === "plan"
        ? "plan mode"
        : `${RUNTIME_MODE_LABEL[input.runtimeMode]} permissions`;
    }
    return label;
  });
  live.onEvent({
    type: "status",
    key: "claude-live-settings",
    text: `Changed ${joinLabels(parts)} without restarting Claude Code`,
  });
}

/**
 * Model, effort or permission changes made while a turn runs (autopilot
 * switching on, the picker): applied to the running process at once where
 * Claude Code can take them, otherwise from the next message, said in the
 * chat. A process with no turn running takes them when the next one starts.
 */
export async function applyClaudeSettings(
  input: LiveSettingsInput,
): Promise<LiveSettingsOutcome> {
  const live = liveByThread.get(input.sessionId);
  if (!live) return "idle";
  const next = claudeLaunchFor({
    sessionId: input.sessionId,
    cwd: live.cwd,
    model: input.model,
    modelSettings: input.modelSettings,
    providerAccountId: live.providerAccountId,
    runtimeMode: input.runtimeMode,
    intent: live.planning ? "plan" : undefined,
    onEvent: live.onEvent,
  });
  const delta = claudeLaunchDelta(live.launch, next);
  if (delta.restart.length === 0 && delta.requests.length === 0) {
    live.runtimeMode = input.runtimeMode;
    return "unchanged";
  }
  if (!live.activeTurn) return "idle";
  const later = (what: string) => {
    if (live.muteUpdates) return;
    live.onEvent({
      type: "notice",
      key: "claude-live-settings",
      text: `The ${what} change applies from your next message; Claude Code restarts for it then.`,
    });
  };
  if (delta.restart.length > 0) {
    later(joinLabels(delta.restart));
    return "next-turn";
  }
  if (!(await applyLiveRequests(input.sessionId, live, delta.requests))) {
    later(joinLabels(delta.requests.map((request) => request.label)));
    return "next-turn";
  }
  live.launch = appliedLaunch(live.launch, next);
  live.runtimeMode = input.runtimeMode;
  if (!live.muteUpdates) noteAppliedLive(live, delta.requests, input);
  return "applied";
}

function launchOptions(
  input: HarnessSessionInput,
  resume?: string,
  sessionId?: string,
): {
  model?: string;
  effort?: string;
  permissionMode?: ReturnType<typeof runtimeModeToPermission>;
  resume?: string;
  sessionId?: string;
  settings?: ClaudeCliSettings;
  routedModel?: string;
  firstMate?: boolean;
} {
  const route = customModelRoute({ model: input.model, modelSettings: input.modelSettings ?? {} });
  const native = route ? route.modelId : nativeModelId(input.model);
  const effortRaw = input.modelSettings?.effort;
  const context = input.modelSettings?.context;
  const settings: ClaudeCliSettings = {};
  if (input.modelSettings?.thinking === "true") {
    settings.alwaysThinkingEnabled = true;
  }
  if (input.modelSettings?.fast === "true") {
    settings.fastMode = true;
  }
  if (isClaudeUltracodeEffort(effortRaw)) {
    settings.ultracode = true;
  }
  if (!loadClaudeHooks()) {
    settings.disableAllHooks = true;
  }
  // Long-running chats compact at their ceiling instead of near the window.
  const ceiling = contextCeilingFor({ harness: "claude", model: input.model });
  if (ceiling) settings.autoCompactWindow = ceiling;
  // WP-16: on the DeepSeek launcher the model asked for runs as DeepSeek, by the
  // launcher's own name. A model it can't place throws here, before anything starts.
  const asked = route ? route.modelId : resolveClaudeApiModelId(native, context);
  const bridge = claudeBridgeKind();
  return {
    model: bridge ? bridgeLaunchModel(asked, bridge) : asked,
    effort: route ? undefined : normalizeClaudeCliEffort(effortRaw, native),
    permissionMode:
      input.intent === "plan"
        ? "plan"
        : runtimeModeToPermission(input.runtimeMode),
    resume,
    sessionId: resume ? undefined : sessionId,
    settings: Object.keys(settings).length > 0 ? settings : undefined,
    routedModel: route ? route.modelId : undefined,
    // Hivra WP-10: a first mate starts without file-editing tools.
    ...(input.firstMate ? { firstMate: true } : {}),
  };
}

/** Exported for tests: whether the harness still keeps a chat's open goal, or the record of one it finished. */
export function __claudeGoalState(threadId: string): { open: boolean; ended: boolean } {
  return { open: goalByThread.has(threadId), ended: goalEnded.has(threadId) };
}

/** Exported for tests. */
export function __claudeTestReset(): void {
  for (const threadId of [...liveByThread.keys(), ...resumeByThread.keys()]) {
    forgetPromptCache(threadId);
  }
  liveByThread.clear();
  resumeByThread.clear();
  tasksByThread.clear();
  cancelledThreads.clear();
  briefOwed.clear();
  goalByThread.clear();
  goalEnded.clear();
  effortNoticesByThread.clear();
  clearNotedAppends();
}
