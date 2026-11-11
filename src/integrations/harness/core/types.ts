import type {
  AgentStepKind,
  ApprovalCall,
  Attachment,
  CutWork,
  InterjectionMeta,
  RuntimeMode,
  SessionGoal,
  TaskListItem,
  ToolPreview,
  TurnIntent,
  TurnMetrics,
} from "../../../features/sessions/model/session";
import type { UserQuestion } from "../../../features/sessions/model/userQuestion";
import type { WorkflowRunMeta } from "../../../features/sessions/model/workflowRun";

/**
 * Why a provider refused or failed a turn. It travels with the error into the
 * turn's outcome and a Lead's report, so "completed" is never claimed for a
 * turn the provider refused. Auth and billing are never worth retrying as-is.
 */
export type ProviderErrorClass =
  | "usage_limit"
  | "billing"
  | "auth"
  | "overloaded"
  | "provider_error";

export type HarnessEvent =
  | { type: "session.started" }
  | { type: "session.ended"; code?: number | null }
  | {
      type: "session.error";
      message: string;
      /** Why the provider failed the turn, when the adapter can tell. */
      errorClass?: ProviderErrorClass;
      /** Sending the turn again later can work with nothing fixed first. */
      retryable?: boolean;
      /** Epoch ms when a refused usage window resets, when known. */
      resetsAt?: number;
    }
  | { type: "session.providerBound"; providerSessionId: string }
  /**
   * The provider's saved conversation is gone (its transcript was deleted): the stored id is dropped and the turn
   * goes on in a fresh conversation started from the chat's brief. `text` is the note the chat shows.
   */
  | { type: "session.providerLost"; providerSessionId: string; text: string }
  | { type: "turn.started"; providerTurnId: string }
  | { type: "turn.ready" }
  | {
      type: "session.configChanged";
      model?: string;
      modelSettings?: Record<string, string>;
    }
  | { type: "status"; text: string; key?: string }
  /**
   * The provider is retrying a failed API request by itself; the turn goes on
   * unless the last attempt fails too.
   */
  | {
      type: "provider.retry";
      attempt: number;
      maxAttempts: number;
      errorClass: ProviderErrorClass;
      /** HTTP status of the failed request; absent for a connection error. */
      errorStatus?: number;
      /** How long the provider waits before this attempt, in ms. */
      retryDelayMs?: number;
    }
  /**
   * Something the provider tells the user that is not part of the reply, such
   * as a CLI warning or a model fallback. Shown as a quiet line.
   */
  | {
      type: "notice";
      text: string;
      level?: "notice" | "suggestion" | "warning";
      /** Later notices with the same key replace this one in the turn. */
      key?: string;
    }
  /** The provider refused the turn until its usage window resets (epoch ms). */
  | { type: "usage.limited"; resetsAt?: number }
  /** Claude Code's /goal changed: set, checked, met, cleared (claudeGoal.ts). Null when the chat has none. */
  | { type: "goal.updated"; goal: SessionGoal | null }
  /**
   * The agent has yielded but the turn is not over: work it started is still
   * running and will wake it again. Empty once it is back at work.
   */
  | { type: "background.updated"; tasks: string[] }
  /**
   * Everything the turn has running in the background, with ids, whenever it changes (empty when nothing is). Saved
   * with the in-flight row, so a resume after a quit or crash can say what was cut.
   */
  | { type: "background.work"; work: CutWork[] }
  | ({ type: "interjection"; text: string } & InterjectionMeta)
  | { type: "message.delta"; text: string }
  | { type: "message.completed" }
  | {
      type: "image.generated";
      itemId: string;
      data: string;
      name: string;
      alt?: string;
    }
  | {
      type: "image.generated";
      itemId: string;
      path: string;
      name: string;
      mimeType: string;
      size: number;
      alt?: string;
    }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.completed" }
  | {
      type: "tool.started";
      agentModel?: string;
      callId: string;
      title: string;
      kind?: string;
      status?: string;
      /** Work the agent left running when it yielded. */
      background?: boolean;
      preview?: ToolPreview;
      /** The command a shell call runs, when the provider says (the live step line in coding chats). */
      command?: string;
      /** Every path affected when one structured edit changes multiple files. */
      paths?: string[];
    }
  | {
      type: "tool.updated";
      agentModel?: string;
      callId: string;
      title?: string;
      kind?: string;
      status?: string;
      detail?: string;
      preview?: ToolPreview;
      /** Every path affected when one structured edit changes multiple files. */
      paths?: string[];
      /** The command a shell call runs, when the provider says. */
      command?: string;
    }
  /**
   * The provider says a call it started is still running (Claude Code's tool_progress): a heartbeat, so a long build
   * that prints nothing is not read as a stall. Never sent by the app itself.
   */
  | { type: "tool.progress"; callId: string; elapsedMs?: number }
  /** Something a subagent did, mirrored onto its parent Agent tool call. */
  | {
      type: "agent.step";
      /** Tool call id of the parent Agent/Task call. */
      callId: string;
      /** Provider step identity; repeats merge onto the same row. */
      stepId: string;
      kind: AgentStepKind;
      text: string;
      /** Tool kind for a "tool" step, so it gets the right icon. */
      toolKind?: string;
      status?: string;
      detail?: string;
      preview?: ToolPreview;
      /** The subagent's own name, when the provider only reveals it here. */
      agentName?: string;
      agentType?: string;
    }
  | {
      type: "approval.requested";
      requestId: number;
      title: string;
      kind?: string;
      callId?: string;
      preview?: ToolPreview;
      /** Exactly what it would run, when the provider can say. */
      call?: ApprovalCall;
      /** WP-150: true when `call` carries every argument the tool runs with. The phone publishes only those. */
      callComplete?: boolean;
      /** WP-122: the child that asked, so the answer is sent to its port. */
      child?: { name: string; sessionPort: string; detail?: string };
      /** WP-243: the frozen action (tool name + full arguments, hashed; approvalAction.ts). Filled for a CLI that doesn't. */
      actionHash?: string;
    }
  | {
      type: "approval.resolved";
      requestId: number;
      /** "cancelled" = a PermissionRequest hook decided before the user could. */
      decision: "allow" | "deny" | "cancelled";
    }
  | {
      type: "question.asked";
      requestId: number;
      title?: string;
      questions: UserQuestion[];
      callId?: string;
      autoResolveAt?: number;
    }
  | {
      type: "question.updated";
      requestId: number;
      autoResolveAt?: number;
    }
  | {
      type: "question.resolved";
      requestId: number;
      decision: "answered" | "skipped" | "cancelled";
    }
  | {
      type: "tasks.updated";
      key?: string;
      explanation?: string;
      /** Merge changed items into the existing list instead of replacing it. */
      merge?: boolean;
      /** This snapshot owns its labels, so a changed item text is a rename. */
      authoritative?: boolean;
      /** Provider conversation that owns these items. */
      providerSessionId?: string;
      items: TaskListItem[];
    }
  | {
      type: "plan";
      text: string;
      /** Merge identity for deltas and the authoritative completed item. */
      key?: string;
      /** Append a stream delta instead of replacing the current snapshot. */
      append?: boolean;
      /** False marks the plan ready for review. */
      streaming?: boolean;
    }
  /**
   * A workflow run's phases and agents, as a whole snapshot. `callId` is the
   * tool call that launched it; the run's row hangs off that call.
   */
  | { type: "workflow.progress"; callId: string; run: WorkflowRunMeta }
  /** Context-window level after the harness's latest request. */
  | { type: "context"; used?: number; window?: number }
  /** Provider token accounting for the active user turn. */
  | ({ type: "turn.metrics" } & TurnMetrics);

export type ApprovalDecision = "allow" | "deny";

/** The turn is connecting or has just ended; retain the follow-up for later. */
export class TurnNotReadyError extends Error {}

export type HarnessSessionInput = {
  sessionId: string;
  cwd: string;
  model: string;
  modelSettings?: Record<string, string>;
  providerAccountId?: string;
  runtimeMode: RuntimeMode;
  /** Keep provider context in memory; MonoCode owns the saved transcript. */
  ephemeral?: boolean;
  /** Persist Codex context in MonoCode's private Mono store. */
  codexStore?: "mono";
  intent?: TurnIntent;
  /**
   * This session drives MonoCode's control CLI, which reaches the app over
   * loopback. Sandboxes deny network by default, so a lead that cannot open
   * that socket cannot supervise its agents at all.
   */
  controlsAgents?: boolean;
  /** Grants this normal turn access to MonoCode's scoped app CLI. */
  appAccess?: boolean;
  /**
   * Hivra WP-10: this session is a first mate, which reads and never edits the project. CLIs that can run read-only do
   * (src/features/firstmate/model/readOnly.ts); for every CLI the app also checks the checkout after each turn.
   */
  firstMate?: boolean;
  /**
   * Hivra WP-143: this session is a Mono, a coding team or one of their workers (features/crew/model/crewSession.ts).
   * Claude Code starts these on Anthropic with a cheap Explore agent passed as a flag (providers/claude/explorePin.ts).
   */
  crew?: boolean;
  onEvent: (event: HarnessEvent) => void;
};

export type SendTurnInput = HarnessSessionInput & {
  /** WP-176: who started the turn. Only the composer sends "person"; omitted is automated. */
  origin?: "person" | "automated";
  /**
   * WP-247 / WP-243: Ash typed this turn in the composer himself. Set by the composer's own send and nothing else; a
   * brief, a steer from another chat, a habit or an app note never carries it. Only such a turn may set or clear the
   * chat's goal.
   */
  byOwner?: boolean;
  text: string;
  attachments?: Attachment[];
  /** Called once the provider has accepted the user turn. */
  onAccepted?: () => void;
  /**
   * The prompt for a fresh provider conversation when the saved one is gone: the chat's deterministic brief wrapped
   * around `text`. Without it the fresh conversation gets `text` alone.
   */
  resumeFallback?: (text: string) => string;
};

export type CompactContextInput = HarnessSessionInput;

/**
 * Launch settings a running session can take without a restart, where its
 * CLI supports it: model, effort, fast mode, permission mode.
 */
export type LiveSettingsInput = {
  sessionId: string;
  model: string;
  modelSettings?: Record<string, string>;
  runtimeMode: RuntimeMode;
};

/**
 * `applied`: the running CLI took it. `next-turn`: it needs a restart, which
 * happens on the next message (the adapter says so in the chat). `unchanged`:
 * nothing differed. `idle`: no running CLI; the next message starts with it.
 */
export type LiveSettingsOutcome = "applied" | "next-turn" | "unchanged" | "idle";

export type SteerTurnInput = {
  /** WP-176: who sent the steer. Omitted is automated. */
  origin?: "person" | "automated";
  sessionId: string;
  cwd: string;
  model: string;
  modelSettings?: Record<string, string>;
  /** WP-247: Ash typed this steer himself (see SendTurnInput.byOwner). */
  byOwner?: boolean;
  text: string;
  attachments?: Attachment[];
};

export type RewindLastTurnInput = CompactContextInput & {
  /** Provider turn boundary for the visible user message, when known. */
  providerTurnId?: string;
  /** When set, Cursor may resend via session/edit_prompt in one RPC. */
  text?: string;
  attachments?: Attachment[];
};

export type RewindLastTurnResult = {
  /** True when the harness already ran the replacement turn. */
  submitted: boolean;
};
