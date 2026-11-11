import { invoke } from "@tauri-apps/api/core";
import { HARNESSES, type HarnessId, type Session } from "../../sessions/model/session";
import { pathKey } from "../../../shared/lib/paths";
import type { ApprovalDecision, HarnessEvent, ProviderErrorClass } from "../../../integrations/harness/core/types";
import { pendingApprovalForSession } from "../../notifications/model/approvalToast";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";
import {
  goalPlanNodes,
  validateGoal,
  validateGoalCheck,
  validateOrchestrationSettings,
  validateProposedTasks,
  type OrchestrationChoice,
  type OrchestrationProposal,
} from "./orchestrationPlan";
import {
  goalGraphBackend,
  MAX_EXTEND_ROUNDS,
  MAX_REPAIR_CYCLES,
  refusalMessage,
  refusalOf,
  REPLAN_CYCLE,
  type GoalCheckRun,
  type GoalGraphBackend,
  type GoalNodeReport,
  type GoalRunView,
  type HandoffFile,
  type TaskHandoff,
} from "./orchestrationGoal";
import { sumChildUsage, usageFromSession } from "./closingUsage";
import {
  normalizeOrchestrationRun,
  orchestrationCheckoutCwd,
  orchestrationProjectCwd,
  orchestrationWorkspace,
  workspaceIdentity,
  type OrchestrationDispatch,
  type OrchestrationRun,
  type OrchestrationTask,
  type OrchestrationWorkspace,
} from "./orchestrationState";

export {
  orchestrationCheckoutCwd,
  orchestrationProjectCwd,
  orchestrationWorkspace,
  workspaceIdentity,
} from "./orchestrationState";
export type {
  DispatchStage,
  DispatchState,
  OrchestrationDispatch,
  OrchestrationRun,
  OrchestrationTask,
  OrchestrationWorkspace,
  TaskStatus,
  WorkspacePolicy,
} from "./orchestrationState";
export type ControlOutcome = {
  status: "completed" | "failed" | "cancelled";
  text: string;
  error?: string;
  /** Why the provider failed the turn, when it said; see ProviderErrorClass. */
  errorClass?: ProviderErrorClass;
  /** Sending the turn again later can work with nothing fixed first. */
  retryable?: boolean;
  /** Epoch ms when a refused usage window resets. */
  resetsAt?: number;
};
export type WorkerPreparation = {
  scratchDir?: string;
  workspace: OrchestrationWorkspace;
};
export type OrchestrationHost = {
  session(id: string): Session | undefined;
  sessions(): Session[];
  choices(): { harness: HarnessId; models: { id: string; name: string }[] }[];
  /** WP-141 round 6: the CLIs on Never use for a folder, read from the crew policy in force there. */
  neverUse?(folder: string): Promise<readonly string[]>;
  createWorker(
    run: OrchestrationRun,
    task: OrchestrationTask,
  ): Promise<WorkerPreparation>;
  integrateWorker(
    run: OrchestrationRun,
    task: OrchestrationTask,
  ): Promise<{ files: string[]; alreadyApplied: number }>;
  /** WP-40's check on the worker's own copy, once its turn is in, in WP-40's own words. `null` means the project has no
   * check configured, so nothing ran and the task records no word; `notRun` means one is configured but could not run.
   * Both are not a pass: the run's report says which tasks no gate checked. */
  gateWorker?(
    run: OrchestrationRun,
    task: OrchestrationTask,
  ): Promise<"passed" | "failed" | "notRun" | null>;
  /** Returns false when unreviewed changes require the worktree to be kept. */
  cleanupWorker(
    run: OrchestrationRun,
    task: OrchestrationTask,
    onlyIfUnchanged: boolean,
  ): Promise<boolean>;
  submit(
    id: string,
    text: string,
    done: (outcome: ControlOutcome) => void,
  ): void;
  stop(id: string): Promise<void>;
  /** Redirect a worker mid-turn, without discarding what it has already done. */
  steer(id: string, text: string): Promise<void>;
  /** Answer on a worker's behalf; the lead, not the user, decides. */
  respondApproval(
    id: string,
    requestId: number,
    decision: ApprovalDecision,
  ): void;
  answerQuestion(id: string, requestId: number, reply: UserQuestionReply): void;
  /**
   * WP-91: the project a decision about this run's folder sits under (the hub project's id, as a delegation's project
   * is named). Without it, or when it names nothing, the folder itself is the project.
   */
  decisionProject?(projectCwd: string): string | undefined;
};
/** A WP-14 decision raised through the app's decision store (`decisions_ask`). */
export type StoredDecision = {
  key: string;
  answered: boolean;
  answer?: string;
};

type Storage = {
  save(run: OrchestrationRun): Promise<void>;
  load(id: string): Promise<OrchestrationRun | null>;
  enable(id: string, cwd: string): Promise<string>;
  disable(id: string): Promise<void>;
  scopes(cwd: string, files: string[]): Promise<string[]>;
  resolvePath(path: string): Promise<string>;
  /** WP-91: raise an irreversible step's decision, and read the store back. */
  askDecision(input: {
    leadId: string;
    taskId: string;
    title: string;
    reason: string;
    project?: string;
  }): Promise<StoredDecision>;
  decisions(): Promise<StoredDecision[]>;
};

/** The decision key for an irreversible step: stable for the run and the task, so re-raising never duplicates it. */
export const irreversibleDecisionKey = (leadId: string, taskId: string) =>
  `irreversible/${leadId}/${taskId}`;

/**
 * What `decisions_ask` is given for an irreversible step. The project is the one the run works in: a decision with
 * none is under no project, which the Inbox and Home both leave out, so nobody would ever see it to answer it.
 */
export const decisionAskInput = (input: {
  leadId: string;
  taskId: string;
  title: string;
  reason: string;
  project?: string;
}) => ({
  askedBy: input.leadId,
  ...(input.project?.trim() ? { project: input.project.trim() } : {}),
  key: irreversibleDecisionKey(input.leadId, input.taskId),
  question: `${input.title} cannot be undone: ${input.reason} Approve it, or send it back with your words.`,
  options: ["Approve", "Send back"],
  recommended: "Send back",
});

const decisionRecord = (value: unknown): StoredDecision | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.decisionKey !== "string") return null;
  return {
    key: input.decisionKey,
    answered: input.state === "answered",
    ...(typeof input.answer === "string" ? { answer: input.answer } : {}),
  };
};
const storage: Storage = {
  save: (run) =>
    invoke("control_save", { leadId: run.leadId, state: JSON.stringify(run) }),
  load: async (id) => {
    const raw = await invoke<string | null>("control_load", { leadId: id });
    if (!raw) return null;
    const run = JSON.parse(raw) as OrchestrationRun;
    if (
      (run.version !== 1 && run.version !== 2) ||
      run.leadId !== id ||
      !Array.isArray(run.tasks)
    )
      throw new Error("Unsupported orchestration history");
    return normalizeOrchestrationRun(run);
  },
  enable: (sessionId, cwd) => invoke("control_enable", { sessionId, cwd }),
  disable: (sessionId) => invoke("control_disable", { sessionId }),
  scopes: (cwd, files) => invoke("control_scopes", { cwd, files }),
  resolvePath: (path) => invoke("control_write_path", { path }),
  askDecision: async (input) => {
    const outcome = (await invoke("decisions_ask", {
      input: decisionAskInput(input),
    })) as { decision?: unknown };
    const decision = decisionRecord(outcome?.decision);
    if (!decision) throw new Error("The decision store answered nothing");
    return decision;
  },
  decisions: async () => {
    const listed = (await invoke("decisions_list", { answered: 50 })) as unknown[];
    return (Array.isArray(listed) ? listed : [])
      .map(decisionRecord)
      .filter((entry): entry is StoredDecision => !!entry);
  },
};

/**
 * One comparison form for scopes returned by Rust and paths reported by a
 * harness. Windows canonicalize uses the extended `\\?\D:\...` form while
 * providers usually report `D:\...`; both must describe the same location.
 */
export function orchestrationPathKey(value: string): string {
  // A scope can arrive with CRLF or padding (a model, a copied file); neither makes it a different path.
  let slashed = value.replace(/\r/g, "").trim().replace(/\\/g, "/");
  if (/^\/\/\?\/unc\//i.test(slashed)) slashed = `//${slashed.slice(8)}`;
  else if (/^\/\/\?\/[a-z]:\//i.test(slashed)) slashed = slashed.slice(4);

  const prefix = slashed.startsWith("//")
    ? "//"
    : /^[A-Za-z]:\//.test(slashed)
      ? slashed.slice(0, 3)
      : slashed.startsWith("/")
        ? "/"
        : "";
  const parts: string[] = [];
  for (const part of slashed.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return pathKey(`${prefix}${parts.join("/")}` || ".");
}

const scopeContains = (scope: string, path: string) =>
  path === scope || path.startsWith(scope.endsWith("/") ? scope : `${scope}/`);

export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((left) => {
    const leftKey = orchestrationPathKey(left);
    return b.some((right) => {
      const rightKey = orchestrationPathKey(right);
      return (
        scopeContains(leftKey, rightKey) || scopeContains(rightKey, leftKey)
      );
    });
  });
}
/**
 * WP-91: the run as the goal graph's rules read it. Everything here is what the record already says — a task is
 * accepted because `review` accepted it, its gates passed because WP-40 said so — never what an agent reported.
 */
export function goalRunView(run: OrchestrationRun): GoalRunView {
  return {
    goal: run.goal ?? "",
    nodes: run.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      role: task.role ?? "build",
      dependsOn: task.dependsOn,
      writeScope: task.files,
      accepted: task.accepted,
      // The word itself, never a boolean: the rules decide what counts as a pass, and `held`/`notRun`/an absent
      // outcome are not one.
      ...(task.gateOutcome ? { gateOutcome: task.gateOutcome } : {}),
      failed: task.status === "failed" || task.status === "blocked",
      cancelled: task.status === "cancelled",
      ...(task.handoff ? { handoff: task.handoff } : {}),
      ...(task.repairs ? { repairs: task.repairs } : {}),
      ...(task.irreversible
        ? {
            irreversible: {
              reason: task.irreversibleReason ?? "",
              key: task.irreversibleKey ?? irreversibleDecisionKey(run.leadId, task.id),
              answered: task.irreversibleAnswered === true,
            },
          }
        : {}),
    })),
    ...(run.baseline ? { baseline: run.baseline } : {}),
    ...(lastCheckRun(run) ? { latest: lastCheckRun(run)! } : {}),
    repairs: run.repairCycles ?? {},
    extends: run.extends ?? 0,
  };
}

/** WP-91: the reason codes a run is not done, in the words a person reads. */
export function describeGoalReport(report: GoalNodeReport): string {
  if (!report.reasons.length) return "the rules named no reason.";
  return report.reasons
    .map((reason) => {
      const [code, ids] = reason.split(":", 2);
      const named = ids ? ` (${ids})` : "";
      switch (code) {
        case "refused":
          return `the plan itself was refused: ${ids ?? ""}`;
        case "check_failed":
          return "the finish-line check failed";
        case "check_not_run":
          return "the finish-line check has not run, or could not";
        case "gate_failed":
          return `a task's gates did not pass${named}`;
        case "gate_not_run":
          return `a gate did not run, or is waiting for a decision${named}`;
        case "task_failed":
          return `a task failed and was not repaired${named}`;
        case "tasks_open":
          return `tasks are still open${named}`;
        case "irreversible_unanswered":
          return `an irreversible step is still waiting for the person${named}`;
        case "no_verification_node":
          return "no verify task follows the work";
        case "no_producers":
          return "no task built anything for a verify task to check";
        case "verification_open":
          return `the verify task has not been accepted${named}`;
        case "verification_misses":
          return `the verify task does not follow every task that writes${named}`;
        case "handoff_not_checked":
          return `a handoff was never opened or is missing${named}`;
        default:
          return reason;
      }
    })
    .join("; ");
}

/** The newest run of the finish-line check, whichever layer made it. */
export function lastCheckRun(run: OrchestrationRun): GoalCheckRun | undefined {
  return run.checkRuns?.length ? run.checkRuns[run.checkRuns.length - 1] : undefined;
}

/** Keep one entry per layer, so the record says which layer ran the check once (WP-81). */
export function withCheckRun(
  run: OrchestrationRun,
  entry: GoalCheckRun,
): OrchestrationRun {
  return {
    ...run,
    checkRuns: [...(run.checkRuns ?? []).filter((known) => known.layer !== entry.layer), entry],
  };
}

const activeTask = (task: OrchestrationTask) =>
  task.status === "running" || task.status === "cancelling";
export const sameCheckout = (a: string, b: string) =>
  pathKey(a.replace(/\\/g, "/")) === pathKey(b.replace(/\\/g, "/"));
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const recoveryTurn = (reason: string) =>
  `Continue the existing assignment from its retained worker checkout. The previous turn was stopped because the orchestration run was interrupted: ${reason}\n\nInspect the current files and prior conversation before acting. Preserve completed work, do not repeat destructive or external operations, remain inside the assigned write scope, run the remaining focused checks, and report what was already done versus what you completed now.`;

const ASSIGNMENT_BLOCK =
  /(?:\r?\n[ \t]*)*<monocode_assignment\b[^>]*>[\s\S]*?<\/monocode_assignment>/gi;

/** Prompt the worker receives, including the envelope the transcript hides. */
export function workerTurnPrompt(
  prompt: string,
  files: string[],
  scratchDir?: string,
  handoffPath?: string,
  /** The handoff files of the accepted tasks this one waits on. Their paths only: what they say is the lead's to
   * read and weigh, not something the next worker is told to trust. */
  predecessorHandoffs: string[] = [],
): string {
  const scratch = scratchDir
    ? ` Temporary helpers and test output may be written in your private scratch directory: ${JSON.stringify(scratchDir)}. TMPDIR, TMP and TEMP point there. Use this directory for scratch files; do not write elsewhere outside the project. Deliver final changes in your assigned project files.`
    : "";
  const handoff = handoffPath
    ? ` Before you finish, write your handoff into your own checkout at ${JSON.stringify(handoffPath)} — a short Markdown file with exactly four headings: "Changed" (what you did), "Files" (the paths you changed), "Checked" (the command you ran and its result), and "Left" (what is still open, or "nothing"). The lead cannot accept this task until that file exists; keep it short.`
    : "";
  const earlier = predecessorHandoffs.length
    ? ` The handoffs of the accepted tasks you wait on are at ${predecessorHandoffs
        .map((path) => JSON.stringify(path))
        .join(", ")}. Read them if you need their context; their claims are not proof, so check the files yourself.`
    : "";
  return `${prompt}\n\n<monocode_assignment>\nYou are a worker managed by a MonoCode lead. Work only in the checkout selected for this run. The workspace, scope and Git rules in this assignment envelope override any contradictory wording in the task text above. Your assigned write scope is: ${files.join(", ")}.${scratch} Read other files as needed, but do not edit outside your scope. If another file or shared operation is needed, report the blocker and stop so the lead can expand or create a new assignment. Do not spawn agents, create worktrees, switch branches, stage, commit, push, install dependencies or run broad formatters/generators. A task owning '.' may run explicitly requested project-wide validation or generation, but Git finalization remains the lead's responsibility after integration. Other workers may be working concurrently in separate checkouts; do not rely on their work until the lead has accepted it.${earlier}${handoff} Report focused checks, changed files, remaining issues and a concise final result.\n</monocode_assignment>`;
}

/** Where a worker writes its handoff, relative to its own checkout. */
export const HANDOFF_DIR = ".hivra/handoff";
/**
 * A handoff is named after its task id, so the id must be one plain path segment: no separator, drive letter, `..` or
 * control character. The same rule as `goal_graph::handoff::safe_segment`, which reads the file back. A task read
 * from disk with any other id gets no handoff path rather than one that leads out of the checkout.
 */
const plainSegment = (id: string) =>
  id.length > 0 &&
  id.length <= 128 &&
  id !== "." &&
  id !== ".." &&
  ![...id].some((char) => "\\/:".includes(char) || /\p{Cc}/u.test(char));
export const handoffRelativePath = (taskId: string) => {
  if (!plainSegment(taskId))
    throw new Error(
      `A handoff file is named after its task id, and ${JSON.stringify(taskId)} is not a task id.`,
    );
  return `${HANDOFF_DIR}/${taskId}.md`;
};

/** Task text a person should see: the assignment envelope stays in the send. */
export function visibleUserPrompt(text: string): string {
  return text.replace(ASSIGNMENT_BLOCK, "").trimEnd();
}

function text(value: unknown, label: string, max = 30_000): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid ${label}: provide a non-empty string`);
  if (value.length > max)
    throw new Error(`Invalid ${label}: keep it under ${max} characters`);
  return value.trim();
}
function strings(value: unknown, label: string, max = 64): string[] {
  if (!Array.isArray(value))
    throw new Error(`Invalid ${label}: provide an array of strings`);
  if (value.length > max)
    throw new Error(`Invalid ${label}: at most ${max} entries`);
  return [...new Set(value.map((item) => text(item, label, 512)))];
}
/**
 * A mistyped field must fail loudly rather than silently change the task. A
 * Map, so an action named after an Object member is still just unknown.
 */
const FIELDS = new Map<string, string[]>([
  ["list", []],
  [
    "delegate",
    [
      "title",
      "harness",
      "model",
      "prompt",
      "files",
      "dependsOn",
      "role",
      "irreversible",
      "reason",
      "extend",
    ],
  ],
  ["get", ["taskId"]],
  ["message", ["taskId", "text"]],
  ["retry", ["taskId", "text", "files"]],
  ["repair", ["taskId", "title", "prompt", "files"]],
  ["approve", ["taskId"]],
  ["cancel", ["taskId"]],
  ["wait", ["timeoutSeconds"]],
  ["review", ["taskId"]],
  ["finish", []],
  ["steer", ["taskId", "text"]],
  ["respond", ["taskId", "requestId", "decision"]],
  ["answer", ["taskId", "requestId", "answers", "skip"]],
]);
function checkFields(action: string, input: Record<string, unknown>) {
  const allowed = FIELDS.get(action);
  if (!allowed)
    throw new Error(
      `Unknown action "${action}". Use one of: ${[...FIELDS.keys()].join(", ")}. Run the control CLI with --help.`,
    );
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length)
    throw new Error(
      `Unknown ${action} field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ${allowed.length ? `${action} accepts: ${allowed.join(", ")}.` : `${action} takes no input.`}`,
    );
}
/**
 * Quote the executable for the shell the lead runs in, and only when needed.
 * The path is absolute, so a leading slash means a POSIX shell — where a
 * backslash escapes rather than separates, and so is never safe bare.
 */
export function shellPath(path: string): string {
  if (path.startsWith("/"))
    return /^[A-Za-z0-9._/:-]+$/.test(path)
      ? path
      : `'${path.replace(/'/g, `'\\''`)}'`;
  return /[\s"]/.test(path) ? `"${path.replace(/"/g, "")}"` : path;
}
/** Said when this copy of the app can't hand an agent its `app` command (no native side, as in a browser preview). */
export const APP_CLI_MISSING = "This copy of MonoCode can't run agents: its app command isn't available here.";

/**
 * The `app` command an agent is told to use. `app_cli_path` answers a path in the app; a copy without the native side
 * answers nothing, which is said plainly instead of failing inside shellPath.
 */
export function appCliCommand(path: unknown): string {
  if (typeof path !== "string" || !path.trim()) throw new Error(APP_CLI_MISSING);
  return `${shellPath(path)} app`;
}
/** Map the lead's chosen option IDs onto the worker's own question shape. */
function questionAnswers(
  value: unknown,
  questions: { id: string; options: { id: string }[] }[] = [],
): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      'answers must be an object of questionId -> [optionId], or pass {"skip":true}',
    );
  const answers: Record<string, string[]> = {};
  for (const [id, chosen] of Object.entries(value)) {
    const question = questions.find((entry) => entry.id === id);
    if (!question)
      throw new Error(
        `Unknown question "${id}". Ask for: ${listed(questions.map((entry) => entry.id)) || "none"}.`,
      );
    const ids = strings(chosen, `answers.${id}`, 16);
    const unknown = ids.filter(
      (option) => !question.options.some((entry) => entry.id === option),
    );
    if (unknown.length)
      throw new Error(
        `Unknown option${unknown.length > 1 ? "s" : ""} for "${id}": ${listed(unknown)}. Choose from: ${listed(question.options.map((entry) => entry.id))}.`,
      );
    answers[id] = ids;
  }
  if (!Object.keys(answers).length)
    throw new Error('Answer at least one question, or pass {"skip":true}');
  return answers;
}
const listed = (values: string[], max = 12) =>
  values.length > max
    ? `${values.slice(0, max).join(", ")} (+${values.length - max} more)`
    : values.join(", ");

export class Orchestrator {
  private runs: OrchestrationRun[] = [];
  private listeners = new Set<() => void>();
  private loaded = new Set<string>();
  private deleted = new Set<string>();
  private persisted = new Map<string, OrchestrationRun>();
  private saves = Promise.resolve();
  private actions = Promise.resolve();
  private pumping = false;
  private starting = new Set<string>();
  private pumpAgain = false;
  /** One wake-up for pool-full waits. An earlier time is kept. */
  private poolWake: {
    at: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private waking = new Set<string>();
  private blocked = new Map<string, string>();
  private announced = new Map<string, Set<string>>();
  /** Async write checks are isolated per dispatch, including retries. */
  private writeChecks = new Map<string, Set<Promise<void>>>();
  private inflight = new Map<
    string,
    { signature: string; promise: Promise<unknown> }
  >();
  private host: OrchestrationHost | null = null;
  constructor(
    private readonly store: Storage = storage,
    /** WP-91: the goal graph's rules and the finish-line check, all of them in Rust. */
    private readonly goals: GoalGraphBackend = goalGraphBackend,
  ) {}
  bind(host: OrchestrationHost) {
    this.host = host;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.runs;
  run(id: string) {
    return this.runs.find((run) => run.leadId === id);
  }
  forSession(id: string) {
    return this.runs.find(
      (run) =>
        run.leadId === id || run.tasks.some((task) => task.sessionId === id),
    );
  }
  resumeBlocker(leadId: string, checkoutCwd?: string): Session | undefined {
    const lead = this.host?.session(leadId);
    if (!lead) return undefined;
    const cwd =
      checkoutCwd ??
      (this.run(leadId)
        ? orchestrationCheckoutCwd(this.run(leadId)!)
        : (lead.worktreeCwd ?? lead.cwd));
    return this.host
      ?.sessions()
      .find(
        (session) =>
          session.id !== leadId &&
          session.busy &&
          sameCheckout(session.worktreeCwd ?? session.cwd, cwd),
      );
  }
  resumeLeadBusy(leadId: string): boolean {
    return !!this.host?.session(leadId)?.busy;
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private async commit(run: OrchestrationRun) {
    run = normalizeOrchestrationRun(run);
    this.runs = [
      ...this.runs.filter((entry) => entry.leadId !== run.leadId),
      run,
    ];
    this.emit();
    const saved = this.saves
      .catch(() => undefined)
      .then(async () => {
        await this.store.save(run);
        this.persisted.set(run.leadId, run);
      });
    this.saves = saved;
    try {
      await saved;
    } catch (error) {
      const current = this.run(run.leadId)!;
      const running = current.tasks.filter(activeTask);
      this.runs = this.runs.map((entry) =>
        entry.leadId === run.leadId
          ? {
              ...entry,
              status: "paused",
              error: `Could not save run: ${messageOf(error)}`,
              tasks: entry.tasks.map((task) =>
                activeTask(task) ? { ...task, status: "cancelling" } : task,
              ),
            }
          : entry,
      );
      this.emit();
      // Keep the checkout reserved until processes have stopped, even if the
      // database is unavailable. Resume sends a recovery turn into the same
      // retained checkout instead of pretending the interrupted turn finished.
      await Promise.allSettled(
        [run.leadId, ...running.map((task) => task.sessionId)].map(
          async (id) => {
            await this.host?.stop(id);
            const latest = this.run(run.leadId)!;
            const stoppedTask = latest.tasks.find(
              (task) => task.sessionId === id && activeTask(task),
            );
            this.runs = this.runs.map((entry) =>
              entry.leadId === run.leadId
                ? {
                    ...latest,
                    tasks: latest.tasks.map((task) =>
                      task.sessionId === id && activeTask(task)
                        ? {
                            ...task,
                            status: "interrupted",
                            accepted: false,
                            delivered: true,
                            activeDispatchId: undefined,
                            ...(task.activeDispatchId
                              ? { lastDispatchId: task.activeDispatchId }
                              : {}),
                            error:
                              "Stopped because run history could not be saved. Resume will continue from the retained worker checkout.",
                            recoveryPrompt: recoveryTurn(
                              "run history could not be saved",
                            ),
                          }
                        : task,
                    ),
                    dispatches: (latest.dispatches ?? []).map((dispatch) =>
                      dispatch.id === stoppedTask?.activeDispatchId
                        ? {
                            ...dispatch,
                            state: "interrupted",
                            stage: "settled",
                            updatedAt: Date.now(),
                            error:
                              "Stopped because run history could not be saved.",
                          }
                        : dispatch,
                    ),
                  }
                : entry,
            );
            this.emit();
          },
        ),
      );
      throw error;
    }
  }
  private async patchTask(
    leadId: string,
    id: string,
    patch: Partial<OrchestrationTask>,
  ) {
    const run = this.run(leadId);
    if (run)
      await this.commit({
        ...run,
        tasks: run.tasks.map((task) =>
          task.id === id ? { ...task, ...patch } : task,
        ),
      });
  }
  private async patchDispatch(
    leadId: string,
    dispatchId: string,
    patch: Partial<OrchestrationDispatch>,
  ) {
    const run = this.run(leadId);
    if (run)
      await this.commit({
        ...run,
        dispatches: (run.dispatches ?? []).map((dispatch) =>
          dispatch.id === dispatchId
            ? { ...dispatch, ...patch, updatedAt: Date.now() }
            : dispatch,
        ),
      });
  }
  /**
   * WP-91: ask the rules about the run again and store their answer, so the card, the sidebar and the lead all read
   * one report rather than each deciding for itself. Never throws: a rule engine that cannot answer must not stop a
   * run that is otherwise fine.
   */
  private async refreshGoalReport(leadId: string): Promise<GoalNodeReport | undefined> {
    const run = this.run(leadId);
    if (!run) return undefined;
    try {
      const answer = await this.goals.report(goalRunView(run));
      // A graph the rules refuse is not a verdict: its own words are carried as the reason, so the lead and the
      // card say what is wrong with the run rather than "no reason named".
      const report: GoalNodeReport = answer.refusal
        ? {
            ...answer.report,
            reasons: [`refused:${answer.refusal.say}`, ...answer.report.reasons],
          }
        : answer.report;
      const current = this.run(leadId);
      if (!current) return report;
      await this.commit({ ...current, goalReport: report });
      return report;
    } catch (error) {
      console.error("Could not read the goal graph", error);
      return this.run(leadId)?.goalReport;
    }
  }

  /**
   * Run the finish-line check in `cwd` and record it. A check that could not run is recorded as `notRun`: never a
   * pass and never a final failure.
   */
  private async runGoalCheck(
    leadId: string,
    cwd: string,
    layer: string,
  ): Promise<GoalCheckRun | undefined> {
    const run = this.run(leadId);
    const spec = run?.check;
    if (!run || !spec) return undefined;
    let entry: GoalCheckRun;
    try {
      entry = { ...(await this.goals.runCheck(cwd, spec)), layer };
    } catch (error) {
      entry = {
        outcome: "notRun",
        output: refusalMessage(error),
        layer,
        at: Date.now(),
      };
    }
    const current = this.run(leadId);
    if (current) await this.commit(withCheckRun(current, entry));
    return entry;
  }

  /** The project an irreversible step's decision sits under: the host's name for it, else the run's folder. */
  private decisionProject(leadId: string): string | undefined {
    const run = this.run(leadId);
    if (!run) return undefined;
    const folder = orchestrationProjectCwd(run);
    try {
      return this.host?.decisionProject?.(folder)?.trim() || folder;
    } catch (error) {
      console.error("Could not name the decision's project", error);
      return folder;
    }
  }

  /**
   * WP-91: the person's stand on an irreversible step. Raised before the task's first dispatch and answered only by
   * the person; an unanswered one means that part does not start.
   */
  private async gateIrreversible(
    leadId: string,
    task: OrchestrationTask,
  ): Promise<"go" | "wait" | "sent-back"> {
    if (!task.irreversible) return "go";
    if (task.irreversibleAnswered) return "go";
    const key = task.irreversibleKey ?? irreversibleDecisionKey(leadId, task.id);
    let answer: StoredDecision | undefined;
    try {
      answer = (await this.store.decisions()).find((entry) => entry.key === key);
    } catch (error) {
      // The decision store is unreachable this pass: wait, never guess on the person's behalf.
      console.error("Could not read the decision store", error);
      return "wait";
    }
    if (!answer) {
      try {
        await this.store.askDecision({
          leadId,
          taskId: task.id,
          title: task.title,
          reason: task.irreversibleReason ?? "it cannot be undone",
          project: this.decisionProject(leadId),
        });
      } catch (error) {
        console.error("Could not park the irreversible step", error);
      }
      const latest = this.run(leadId)?.tasks.find((entry) => entry.id === task.id);
      if (latest && latest.irreversibleKey !== key)
        await this.patchTask(leadId, task.id, {
          irreversibleKey: key,
          irreversibleAnswered: false,
        });
      return "wait";
    }
    if (!answer.answered) return "wait";
    const sentBack = !/^approve\b/i.test((answer.answer ?? "").trim());
    if (sentBack) {
      const words = (answer.answer ?? "").trim() || "no reason given";
      await this.patchTask(leadId, task.id, {
        irreversibleKey: key,
        irreversibleAnswered: true,
        status: "failed",
        accepted: false,
        delivered: true,
        error: `Sent back by the person: ${words}`,
        result: `${task.result}\n\nThe person sent this back: ${words}`.trim(),
      });
      return "sent-back";
    }
    await this.patchTask(leadId, task.id, {
      irreversibleKey: key,
      irreversibleAnswered: true,
    });
    return "go";
  }

  /**
   * WP-91: read a finished worker's handoff. A refusal is returned, never thrown, so `review` can say what is wrong
   * in the lead's own words. A handoff that cannot be read for a reason other than "it is not there" is a refusal
   * too: the person's review must not pass on a file the app could not see.
   */
  private async readHandoff(
    task: OrchestrationTask,
  ): Promise<{ handoff?: HandoffFile; refusal?: { code: string; message: string } }> {
    const checkout = task.workspace?.checkoutCwd;
    if (!checkout)
      return {
        refusal: {
          code: "handoff_missing",
          message: `Task ${task.title} has no checkout to read its handoff from.`,
        },
      };
    try {
      return { handoff: await this.goals.readHandoff(checkout, task.id) };
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal) return { refusal };
      return {
        refusal: {
          code: "handoff_unreadable",
          message: `Task ${task.title}'s handoff could not be read: ${messageOf(error)}`,
        },
      };
    }
  }

  private async cleanupUnchangedWorker(
    leadId: string,
    taskId: string,
  ): Promise<boolean> {
    const run = this.run(leadId);
    const task = run?.tasks.find((entry) => entry.id === taskId);
    if (!run || !task || task.workspacePolicy === "shared" || !task.workspace)
      return true;
    try {
      const cleaned = await this.host?.cleanupWorker(run, task, true);
      if (!cleaned) return false;
      const current = this.run(leadId);
      if (!current) return false;
      await this.commit({
        ...current,
        tasks: current.tasks.map((entry) =>
          entry.id === taskId ? { ...entry, workspace: undefined } : entry,
        ),
        dispatches: (current.dispatches ?? []).map((dispatch) =>
          dispatch.id === task.lastDispatchId
            ? {
                ...dispatch,
                stage: "cleaned",
                cleanupError: undefined,
                updatedAt: Date.now(),
              }
            : dispatch,
        ),
      });
      return true;
    } catch (error) {
      if (task.lastDispatchId)
        await this.patchDispatch(leadId, task.lastDispatchId, {
          cleanupError: messageOf(error),
        });
      return false;
    }
  }
  /**
   * WP-91: a repair of the run's verify task just fixed what the verification found, so the verification runs again.
   * A verification is never settled by its repair (the original's `reruns_root`): it goes back in the queue with a note
   * saying what its repair changed, and the run is not done until it passes on its own.
   */
  private async requeueRepairedVerification(leadId: string, repairId: string) {
    const run = this.run(leadId);
    const repair = run?.tasks.find((entry) => entry.id === repairId);
    const root = repair?.repairs
      ? run!.tasks.find((entry) => entry.id === repair.repairs)
      : undefined;
    if (!run || !repair || !root || root.role !== "verify" || root.status === "cancelled")
      return;
    const current = this.run(leadId)!;
    const target = current.tasks.find((entry) => entry.id === root.id)!;
    if (target.status !== "failed" && target.status !== "blocked") return;
    await this.commit({
      ...current,
      tasks: current.tasks.map((entry) =>
        entry.id === root.id
          ? {
              ...entry,
              status: "queued",
              error: undefined,
              recoveryPrompt: `Check the goal again: the repair ${JSON.stringify(
                repair.title,
              )} was accepted after your last turn. What you found before:
${(entry.error ?? entry.result).slice(-2000)}
Run the whole check again and report what you observed.`,
            }
          : entry,
      ),
    });
  }
  async hydrate(id: string) {
    if (this.loaded.has(id) || this.run(id)) return;
    this.loaded.add(id);
    try {
      const loaded = await this.store.load(id);
      if (!loaded || this.run(id) || this.deleted.has(id)) return;
      const run = normalizeOrchestrationRun(loaded);
      if (run.status === "active" || run.tasks.some(activeTask)) {
        await Promise.all(
          [
            id,
            ...run.tasks.filter(activeTask).map((task) => task.sessionId),
          ].map((sessionId) => this.host?.stop(sessionId)),
        );
        await this.store.disable(id);
      }
      const interrupted = new Set(
        run.tasks
          .filter(activeTask)
          .map((task) => task.activeDispatchId)
          .filter((dispatchId): dispatchId is string => !!dispatchId),
      );
      await this.commit({
        ...run,
        status: run.status === "active" ? "paused" : run.status,
        tasks: run.tasks.map((task) =>
          activeTask(task)
            ? {
                ...task,
                status: "interrupted",
                activeDispatchId: undefined,
                ...(task.activeDispatchId
                  ? { lastDispatchId: task.activeDispatchId }
                  : {}),
                accepted: false,
                error:
                  "Interrupted while MonoCode was not running. Resume will continue from the retained worker checkout.",
                recoveryPrompt: recoveryTurn(
                  "MonoCode stopped while the worker was running",
                ),
                delivered: true,
              }
            : { ...task, delivered: task.accepted || task.status === "queued" },
        ),
        dispatches: (run.dispatches ?? []).map((dispatch) =>
          interrupted.has(dispatch.id)
            ? {
                ...dispatch,
                state: "interrupted",
                stage: "settled",
                updatedAt: Date.now(),
                error: "Interrupted while MonoCode was not running.",
              }
            : dispatch,
        ),
        error:
          run.status === "active"
            ? "Run interrupted while MonoCode was not running. Worker checkouts were retained; Resume will continue them."
            : run.error,
        lastPauseReason:
          run.status === "active"
            ? "MonoCode stopped while the orchestration run was active."
            : run.lastPauseReason,
      });
      // A saved run draws again after a reload: the rules answer over what was loaded, so the graph is live before
      // anything else happens.
      void this.refreshGoalReport(id);
    } catch (error) {
      this.loaded.delete(id);
      throw error;
    }
  }
  async start(
    leadId: string,
    allowedHarnesses: HarnessId[],
    maxWorkers: number,
    approved?: {
      proposalId: string;
      allowedModels: OrchestrationChoice[];
      tasks: OrchestrationTask[];
      goal: string;
      check: import("./orchestrationGoal").GoalCheck;
      baseline: GoalCheckRun;
    },
  ) {
    if (this.starting.has(leadId))
      throw new Error("The run is already starting");
    this.starting.add(leadId);
    try {
      await this.startRun(leadId, allowedHarnesses, maxWorkers, approved);
    } finally {
      this.starting.delete(leadId);
    }
  }
  async startApproved(
    leadId: string,
    proposalId: string,
    proposal: OrchestrationProposal,
  ) {
    if (proposal.status !== "ready")
      throw new Error("Review a completed proposal before starting");
    const settings = validateOrchestrationSettings(proposal.settings);
    const planned = validateProposedTasks(
      proposal.tasks,
      settings,
      proposal.checkoutCwd ?? proposal.cwd,
    );
    const goal = validateGoal(proposal.goal);
    const check = validateGoalCheck(proposal.check);
    // WP-91: the graph is checked here, before any process or checkout is made. The dispatch-time overlap check in
    // `pump` stays as the second guard, because `delegate` can add a task after the plan.
    try {
      await this.goals.checkPlan(goalPlanNodes(planned));
    } catch (error) {
      throw new Error(refusalMessage(error));
    }
    const lead = this.host?.session(leadId);
    if (
      !lead ||
      !sameCheckout(lead.cwd, proposal.cwd) ||
      !sameCheckout(
        lead.worktreeCwd ?? lead.cwd,
        proposal.checkoutCwd ?? proposal.cwd,
      )
    )
      throw new Error("Return to the proposal's checkout before starting");
    const available = this.host!.choices();
    const allowedModels = settings.choices.filter((choice) =>
      available.some(
        (entry) =>
          entry.harness === choice.harness &&
          entry.models.some((model) => model.id === choice.model),
      ),
    );
    if (
      planned.some(
        (task) =>
          !allowedModels.some(
            (choice) =>
              choice.harness === task.harness && choice.model === task.model,
          ),
      )
    )
      throw new Error(
        "An assigned model is no longer available. Change that assignment before starting.",
      );
    // The finish line is proved first: the app runs it once in the lead's checkout on the untouched base. A check
    // that already passes proves nothing, and one that cannot run is not a finish line at all.
    const baselineCwd = lead.worktreeCwd ?? lead.cwd;
    let baseline: GoalCheckRun;
    try {
      baseline = {
        ...(await this.goals.runCheck(baselineCwd, check)),
        layer: "app",
      };
    } catch (error) {
      baseline = {
        outcome: "notRun",
        output: refusalMessage(error),
        layer: "app",
        at: Date.now(),
      };
    }
    if (baseline.outcome === "passed")
      throw new Error(
        `This finish-line check already passes on the untouched checkout, so it cannot show the work is done: \`${check.command}\`. Give a check that fails until the goal holds.`,
      );
    if (baseline.outcome === "notRun")
      throw new Error(
        `The finish-line check could not run, so the run has no finish line: ${baseline.output || check.command}`,
      );
    const ids = new Map(planned.map((task) => [task.id, crypto.randomUUID()]));
    const tasks: OrchestrationTask[] = await Promise.all(
      planned.map(async (task) => ({
        ...task,
        id: ids.get(task.id)!,
        assignmentId: task.id,
        sessionId: crypto.randomUUID(),
        scopes: await this.store.scopes(
          lead.worktreeCwd ?? lead.cwd,
          task.files,
        ),
        dependsOn: task.dependsOn.map((id) => ids.get(id)!),
        status: "queued" as const,
        accepted: false,
        delivered: true,
        result: "",
        workspacePolicy: "isolated-child" as const,
        ...(task.irreversible
          ? {
              irreversibleKey: irreversibleDecisionKey(leadId, ids.get(task.id)!),
              irreversibleAnswered: false,
            }
          : {}),
      })),
    );
    const currentLead = this.host?.session(leadId);
    if (
      !currentLead ||
      !sameCheckout(
        currentLead.worktreeCwd ?? currentLead.cwd,
        proposal.checkoutCwd ?? proposal.cwd,
      )
    )
      throw new Error("Return to the proposal's checkout before starting");
    await this.start(
      leadId,
      [...new Set(allowedModels.map((choice) => choice.harness))],
      settings.maxWorkers,
      { proposalId, allowedModels, tasks, goal, check, baseline },
    );
    this.host!.submit(
      leadId,
      `The user confirmed the orchestration card, including any edits. The app has already queued the exact assignments below; do not delegate duplicates. Supervise them through the control CLI, review their changes, request corrections when needed, and finish the original request.\n\nGoal: ${goal}\nFinish line (the app runs this itself, and the run is done only when it passes): ${check.command}, expected exit ${check.expectExit}\nIt failed on the untouched checkout before any work started, which is the baseline.\n\nOriginal request:\n${proposal.request}\n\nApproved assignments:\n${JSON.stringify(tasks.map(({ id, title, prompt, harness, model, modelSettings, files, dependsOn }) => ({ taskId: id, title, prompt, harness, model, modelSettings, files, dependsOn })))}`,
      (outcome) => {
        if (outcome.status !== "completed")
          void this.pause(
            leadId,
            outcome.error ??
              "The lead was interrupted. Its agents were stopped; review and resume the run.",
          ).catch(console.error);
      },
    );
  }
  private async startRun(
    leadId: string,
    allowedHarnesses: HarnessId[],
    maxWorkers: number,
    approved?: {
      proposalId: string;
      allowedModels: OrchestrationChoice[];
      tasks: OrchestrationTask[];
      goal: string;
      check: import("./orchestrationGoal").GoalCheck;
      baseline: GoalCheckRun;
    },
  ) {
    const lead = this.host?.session(leadId);
    if (!lead) throw new Error("The orchestration lead is unavailable");
    if (lead.busy)
      throw new Error(
        this.run(leadId)?.status === "paused"
          ? "Wait for the lead's interrupted turn to finish before resuming orchestration"
          : "Wait for the lead's current turn to finish",
      );
    const workspace = workspaceIdentity(
      lead.cwd,
      lead.worktreeCwd ?? lead.cwd,
      lead.branch,
    );
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4)
      throw new Error("Choose 1 to 4 workers");
    // WP-141 round 6: an approved card never starts a worker on a CLI on Never use for the Lead's folder.
    const banned = new Set((await this.host!.neverUse?.(lead.cwd)) ?? []);
    const onNever = approved?.tasks.find((task) => banned.has(task.harness));
    if (onNever) throw new Error(`${onNever.harness} is on Never use, so this plan was not started. Change it in Settings > Crew Defaults.`);
    allowedHarnesses = allowedHarnesses.filter((id) => !banned.has(id));
    const available = this.host!.choices().map((choice) => choice.harness);
    if (
      !allowedHarnesses.length ||
      allowedHarnesses.some((id) => !available.includes(id))
    )
      throw new Error("Choose installed worker harnesses");
    const previous = this.run(leadId);
    if (
      previous?.status === "active" ||
      (approved && previous?.status === "paused")
    )
      throw new Error("Stop the current run before starting another proposal");
    if (previous?.tasks.some(activeTask))
      throw new Error(
        previous.status === "paused"
          ? "Wait for interrupted agents to stop before resuming orchestration"
          : "Stop active workers before changing the run",
      );
    if (
      previous?.status === "paused" &&
      !sameCheckout(orchestrationCheckoutCwd(previous), workspace.checkoutCwd)
    )
      throw new Error(
        "Return the lead to its original checkout before resuming orchestration",
      );
    const blocker = this.resumeBlocker(leadId, workspace.checkoutCwd);
    if (blocker) {
      const label = blocker.title.trim() || blocker.id;
      throw new Error(
        `"${label}" is still running in this checkout. Stop it before ${
          previous?.status === "paused"
            ? "resuming orchestration"
            : "starting orchestration"
        }.`,
      );
    }
    const [canonicalRoot] = await this.store.scopes(workspace.checkoutCwd, [
      ".",
    ]);
    const cli = await this.store.enable(leadId, workspace.checkoutCwd);
    const resumedTasks =
      previous?.status === "paused"
        ? previous.tasks.map((task) =>
            task.status === "interrupted"
              ? {
                  ...task,
                  status: "queued" as const,
                  error: undefined,
                  delivered: true,
                  accepted: false,
                  activeDispatchId: undefined,
                  recoveryPrompt:
                    task.recoveryPrompt ??
                    recoveryTurn(
                      previous.error ??
                        previous.lastPauseReason ??
                        "the run was paused",
                    ),
                }
              : task,
          )
        : [];
    try {
      await this.host!.stop(leadId); // Refresh the child environment before its next turn.
      await this.commit({
        version: 2,
        leadId,
        cwd: lead.cwd,
        workspace,
        canonicalRoot,
        cli,
        status: "active",
        allowedHarnesses: [...new Set(allowedHarnesses)],
        allowedModels:
          approved?.allowedModels ??
          (previous?.status === "paused" ? previous.allowedModels : undefined),
        proposalId:
          approved?.proposalId ??
          (previous?.status === "paused" ? previous.proposalId : undefined),
        maxWorkers,
        tasks:
          approved?.tasks ??
          (previous?.status === "paused" ? resumedTasks : []),
        dispatches:
          previous?.status === "paused" ? (previous.dispatches ?? []) : [],
        continuations: 0,
        requests: previous?.status === "paused" ? previous.requests : {},
        lastPauseReason:
          previous?.status === "paused"
            ? (previous.error ?? previous.lastPauseReason)
            : undefined,
        // WP-91: the goal, its finish line and its baseline belong to the run and survive a resume.
        goal: approved?.goal ?? (previous?.status === "paused" ? previous.goal : undefined),
        check: approved?.check ?? (previous?.status === "paused" ? previous.check : undefined),
        baseline:
          approved?.baseline ?? (previous?.status === "paused" ? previous.baseline : undefined),
        checkRuns: approved ? [] : (previous?.status === "paused" ? previous.checkRuns : []),
        repairCycles: previous?.status === "paused" ? previous.repairCycles : {},
        extends: previous?.status === "paused" ? previous.extends : 0,
      });
    } catch (error) {
      await this.store.disable(leadId);
      throw error;
    }
    void this.pump();
    this.sync();
    void this.refreshGoalReport(leadId);
  }
  submissionError(id: string, managed = false): string | null {
    if (managed) return null;
    const session = this.host?.session(id);
    if (!session) return null;
    const own = this.forSession(id);
    if (
      own &&
      own.leadId !== id &&
      (own.status === "active" || own.tasks.some(activeTask))
    )
      return "This worker is managed by the orchestrator. Send instructions through its lead or stop the run first.";
    const other = this.runs.find(
      (run) =>
        (run.status === "active" || run.tasks.some(activeTask)) &&
        run.leadId !== id &&
        sameCheckout(
          orchestrationCheckoutCwd(run),
          session.worktreeCwd ?? session.cwd,
        ),
    );
    if (other)
      return "This checkout has an active orchestrator. Stop that run before starting independent work.";
    if (own?.status === "paused")
      return "Resume or stop orchestration before sending the lead another turn.";
    if (
      own?.status === "active" &&
      !sameCheckout(
        orchestrationCheckoutCwd(own),
        session.worktreeCwd ?? session.cwd,
      )
    )
      return "Return the lead to its original project or stop orchestration first.";
    return null;
  }
  prompt(id: string, prompt: string): string {
    const run = this.run(id);
    if (!run || run.status !== "active") return prompt;
    const cli = `${shellPath(run.cli)} control`;
    return `${prompt}\n\n<monocode_orchestration>\nYou are the lead of a local MonoCode run. Coordinate the user's task using ${cli}. Run \`${cli} --help\` before your first command; it documents every action, its exact JSON fields and the retry rule. Credentials are already in your environment; never print them.\nEach call prints one JSON line and exits non-zero unless "ok" is true; read the "error" text, it says what to do next. Unknown JSON fields are rejected rather than ignored, so fix the field name instead of guessing. If a call fails before reaching MonoCode, retry it with the "requestId" from that response so the work is never queued twice.\nUse list to discover allowed harness/model IDs. Delegate bounded tasks with project-relative files (directories reserve their descendants), self-contained prompts and dependsOn task IDs. Use the checkout selected for this run. You may read and plan; leave project file edits to workers. Never start workers outside this CLI. Workers with overlapping files are queued. For project-wide validation, generators or broad formatting, assign a separate task with files ["."] and wait for other workers to finish. Workers must never commit, push, switch branches or write outside the selected checkout. If the user requested those final operations, review and integrate every worker, call finish, then perform the explicitly authorized finalization yourself from the lead checkout.\nAgents never prompt the user. When one needs an approval or answers a question, list, get and wait report it as needsInput on that task, and you decide with respond or answer; it stays stopped until you do. Judge the request against the task you assigned, and put it to the user in this conversation only when the call is genuinely theirs.\nSteer a running agent with steer to correct its course without losing its work; use message only once it has stopped. Read results with get or wait; completed means a turn finished, not that the work passed review. Review the actual changes, message a worker for fixes, and use review to accept each completed task. A scope-blocked worker is isolated to that task: use message if it should stay within its existing scope, retry with corrected project-relative files if the assignment was too narrow, or cancel it if no longer needed. Never expand scope merely to excuse an unexpected write. Call finish only when required work and combined validation are complete: the app runs this run's own finish-line check itself in your checkout, and refuses to finish until the check passes and every task is accepted with its handoff read. Open each result with get before you accept it — that reads the worker's handoff file, and a task cannot be accepted without one. A failed or blocked task is repaired with repair (its own new task, two cycles, the second a re-plan, and only its own dependents wait); a step that cannot be undone waits for the person, who is the only one who may answer it. You receive worker results automatically when idle; use bounded wait calls while supervising. If the run is paused, list/get/wait remain readable and explain the reason. Stop polling, report that reason, and ask the user to click Resume; Resume automatically continues interrupted workers from their retained checkouts. Do not expose credentials, create worktrees, switch branches or silently escalate worker permissions.\n</monocode_orchestration>`;
  }
  async handle(
    leadId: string,
    requestId: string,
    action: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    checkFields(action, input);
    const signature = JSON.stringify({ action, input });
    const key = `${leadId}:${requestId}`;
    const receipts = this.persisted.get(leadId)?.requests;
    const previous =
      receipts &&
      Object.prototype.hasOwnProperty.call(receipts, requestId) &&
      typeof receipts[requestId]?.signature === "string"
        ? receipts[requestId]
        : undefined;
    if (previous) {
      if (previous.signature !== signature)
        throw new Error("Request ID was already used with different input");
      return previous.result;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      if (pending.signature !== signature)
        throw new Error("Request ID was already used with different input");
      return pending.promise;
    }
    if (action === "wait") return this.wait(leadId, input);
    const result = this.actions
      .catch(() => undefined)
      .then(async () => {
        const run = this.run(leadId);
        if (!run)
          throw new Error("No orchestration run was found for this lead");
        if (run.status !== "active" && !["list", "get"].includes(action))
          throw new Error(this.inactiveReason(run));
        if (
          !["list", "get"].includes(action) &&
          Object.keys(run.requests).length >= 512
        )
          throw new Error(
            "Run command limit reached. Stop the run and start another after reviewing the files.",
          );
        return this.execute(run, action, input, requestId, signature);
      });
    this.actions = result.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.set(key, { signature, promise: result });
    try {
      return await result;
    } finally {
      this.inflight.delete(key);
      void this.pump();
    }
  }
  private view(run: OrchestrationRun) {
    return {
      ...run,
      cli: undefined,
      requests: undefined,
      recovery: run.status === "active" ? undefined : this.inactiveReason(run),
      tasks: run.tasks.map((task) => ({
        ...task,
        prompt: undefined,
        scopes: undefined,
        waitingFor: this.waitingFor(run, task),
        needsInput: this.pendingInput(task),
      })),
    };
  }
  private inactiveReason(run: OrchestrationRun): string {
    return run.status === "paused"
      ? `This run is paused. ${run.error ?? "Work was interrupted."} list, get and wait remain available for inspection. Do not retry mutations or keep polling: explain the pause and ask the user to click Resume in MonoCode. Resume will continue interrupted tasks from their retained worker checkouts; policy-blocked tasks remain stopped for an explicit retry or cancellation.`
      : `This run is ${run.status}. Inspect results with list or get; do not keep retrying commands for this run.`;
  }
  /**
   * What a worker is blocked on. Workers have no user-facing prompt: the lead
   * answers for them, and escalates to the user in its own conversation when
   * it does not want to decide alone.
   */
  pendingInput(task: OrchestrationTask) {
    const worker = this.host?.session(task.sessionId);
    const pending = worker && pendingApprovalForSession(worker);
    if (!pending) return undefined;
    return {
      kind: pending.kind,
      requestId: pending.requestId,
      label: pending.label,
      detail:
        pending.kind === "approval"
          ? (pending.block?.tool?.detail?.trim() ?? pending.block?.text)
          : undefined,
      questions: worker?.pendingQuestion?.questions,
    };
  }
  waitingFor(
    run: OrchestrationRun,
    task: OrchestrationTask,
  ): string | undefined {
    if (task.status !== "queued") return undefined;
    if (task.irreversible && !task.irreversibleAnswered)
      return `Waiting for your decision: ${task.irreversibleReason ?? "it cannot be undone"}`;
    const dependency = run.tasks.find(
      (entry) => task.dependsOn.includes(entry.id) && !entry.accepted,
    );
    if (dependency) return `Waiting for review: ${dependency.title}`;
    const owner = run.tasks.find(
      (entry) => activeTask(entry) && scopesOverlap(entry.scopes, task.scopes),
    );
    if (owner) return `Waiting for files: ${owner.title}`;
    if (typeof task.poolNote === "string" && task.poolNote !== "")
      return task.poolNote;
    return "Waiting for a worker slot";
  }
  private async execute(
    run: OrchestrationRun,
    action: string,
    input: Record<string, unknown>,
    requestId: string,
    signature: string,
  ): Promise<unknown> {
    // Persist the mutation and its retry receipt together, before dispatch.
    const record = async (next: OrchestrationRun, result: unknown) => {
      await this.commit({
        ...next,
        requests: { ...next.requests, [requestId]: { signature, result } },
      });
      return result;
    };
    const changeTask = (
      id: string,
      patch: Partial<OrchestrationTask>,
      result: unknown,
    ) => {
      const current = this.run(run.leadId)!;
      return record(
        {
          ...current,
          tasks: current.tasks.map((entry) =>
            entry.id === id ? { ...entry, ...patch } : entry,
          ),
        },
        result,
      );
    };
    const task = () => {
      const id = text(input.taskId, "taskId", 128);
      const found = this.run(run.leadId)!.tasks.find(
        (entry) => entry.id === id,
      );
      if (!found)
        throw new Error(
          "Task does not belong to this run. Use a taskId returned by delegate or list.",
        );
      return found;
    };
    switch (action) {
      case "list":
        return {
          run: this.view(run),
          harnesses: this.host!.choices()
            .filter((choice) => run.allowedHarnesses.includes(choice.harness))
            .map((choice) => ({
              ...choice,
              models: choice.models.filter(
                (model) =>
                  !run.allowedModels ||
                  run.allowedModels.some(
                    (allowed) =>
                      allowed.harness === choice.harness &&
                      allowed.model === model.id,
                  ),
              ),
            })),
        };
      case "get": {
        // The fields list reports, plus this task's own prompt, and — WP-91 — its handoff, which opening this way
        // is what records. A task cannot be accepted until its handoff has been opened.
        let target = task();
        let handoffText: string | undefined;
        let handoffProblem: string | undefined;
        if (
          ["completed", "failed", "blocked", "interrupted"].includes(target.status)
        ) {
          const read = await this.readHandoff(target);
          if (read.refusal) {
            handoffProblem = read.refusal.message;
          } else if (read.handoff) {
            handoffText = read.handoff.text;
            const recorded: TaskHandoff = {
              path: read.handoff.path,
              sha256: read.handoff.sha256,
              bytes: read.handoff.bytes,
              read: true,
              at: Date.now(),
            };
            await this.patchTask(run.leadId, target.id, { handoff: recorded });
            target = this.run(run.leadId)!.tasks.find(
              (entry) => entry.id === target.id,
            )!;
          }
        }
        return {
          ...target,
          runStatus: run.status,
          recovery:
            run.status === "active" ? undefined : this.inactiveReason(run),
          scopes: undefined,
          waitingFor: this.waitingFor(this.run(run.leadId)!, target),
          needsInput: this.pendingInput(target),
          ...(handoffText !== undefined ? { handoffText } : {}),
          ...(handoffProblem ? { handoffProblem } : {}),
        };
      }
      case "delegate": {
        if (run.tasks.length >= 40)
          throw new Error("This run has reached its 40-task limit");
        const harness = text(input.harness, "harness") as HarnessId;
        if (
          !HARNESSES.includes(harness) ||
          !run.allowedHarnesses.includes(harness)
        )
          throw new Error(
            `Harness "${harness}" is not allowed in this run. Allowed: ${listed(run.allowedHarnesses)}.`,
          );
        const choice = this.host!.choices().find(
          (entry) => entry.harness === harness,
        );
        if (!choice) throw new Error("Worker harness is unavailable");
        const permittedModels = choice.models.filter(
          (model) =>
            !run.allowedModels ||
            run.allowedModels.some(
              (allowed) =>
                allowed.harness === harness && allowed.model === model.id,
            ),
        );
        const model =
          input.model == null
            ? permittedModels[0]?.id
            : text(input.model, "model", 256);
        if (!model || !permittedModels.some((item) => item.id === model))
          throw new Error(
            `Choose a model ID returned by list for ${harness}: ${listed(permittedModels.map((item) => item.id)) || "none available"}.`,
          );
        const title = text(input.title, "title", 160);
        const prompt = text(input.prompt, "prompt");
        const files = strings(input.files, "files");
        // WP-91: a verify task checks the goal and may write a report of its own, so it needs no scope. Every other
        // task says what it may write; a verify task delegated after the plan's own was cancelled is the way a run
        // gets its one verify task back.
        if (
          input.role != null &&
          input.role !== "build" &&
          input.role !== "verify"
        )
          throw new Error('A task role is "build" or "verify".');
        const role: "build" | "verify" =
          input.role === "verify" ? "verify" : "build";
        if (!files.length && role !== "verify")
          throw new Error(
            "Declare at least one file/directory scope in files, or '.' for exclusive checkout access",
          );
        const dependsOn = strings(input.dependsOn ?? [], "dependsOn", 40);
        const missing = dependsOn.filter(
          (id) =>
            !run.tasks.some(
              (item) => item.id === id && item.status !== "cancelled",
            ),
        );
        if (missing.length)
          throw new Error(
            `dependsOn must hold taskIds from this run; unknown or cancelled: ${listed(missing)}.`,
          );
        const scopes = await this.store.scopes(
          orchestrationCheckoutCwd(run),
          files,
        );
        // WP-91: an irreversible step declared here is parked for the person before it starts, exactly as one in
        // the plan is; and a node added after the plan counts against the run's two extend rounds.
        const irreversible = input.irreversible === true;
        const reason = irreversible
          ? text(input.reason, "reason", 200)
          : undefined;
        const extend = input.extend === true;
        const takenRounds = this.run(run.leadId)!.extends ?? 0;
        if (extend && takenRounds >= MAX_EXTEND_ROUNDS)
          throw new Error(
            `This run has had ${MAX_EXTEND_ROUNDS} extend rounds. Report what is still open instead of adding more.`,
          );
        // WP-91: an added node came from the run's verify task, the check that found work missing. The graph draws
        // that edge; with no verify task left, the node still records the round it belongs to.
        const extendFrom = extend
          ? this.run(run.leadId)!.tasks.find(
              (task) => task.role === "verify" && task.status !== "cancelled",
            )?.id
          : undefined;
        const id = crypto.randomUUID();
        const created: OrchestrationTask = {
          id,
          sessionId: crypto.randomUUID(),
          title,
          prompt,
          files,
          scopes,
          dependsOn,
          harness,
          model,
          role,
          status: "queued",
          accepted: false,
          result: "",
          delivered: true,
          workspacePolicy: "isolated-child",
          ...(extendFrom ? { extendFrom } : {}),
          ...(irreversible
            ? {
                irreversible: true,
                irreversibleReason: reason,
                irreversibleKey: irreversibleDecisionKey(run.leadId, id),
                irreversibleAnswered: false,
              }
            : {}),
        };
        const result = await record(
          {
            ...this.run(run.leadId)!,
            tasks: [...this.run(run.leadId)!.tasks, created],
            ...(extend ? { extends: takenRounds + 1 } : {}),
          },
          {
            taskId: created.id,
            sessionId: created.sessionId,
            status: "queued",
            ...(extend ? { extendsLeft: MAX_EXTEND_ROUNDS - takenRounds - 1 } : {}),
            ...(irreversible
              ? {
                  parked: true,
                  say: "This task cannot be undone, so it waits for the person to approve or send it back before it starts.",
                }
              : {}),
          },
        );
        void this.pump();
        void this.refreshGoalReport(run.leadId);
        return result;
      }
      case "message": {
        const target = task();
        if (activeTask(target) || target.status === "queued")
          throw new Error(
            `Wait for this worker or cancel it before sending a new turn; ${target.title} is ${target.status}.`,
          );
        if (
          run.tasks.some(
            (entry) =>
              entry.dependsOn.includes(target.id) &&
              entry.status !== "queued" &&
              entry.status !== "cancelled",
          )
        )
          throw new Error(
            "A dependent task has already started; create a separate correction task after it finishes",
          );
        return changeTask(
          target.id,
          {
            prompt: text(input.text, "text"),
            status: "queued",
            accepted: false,
            result: "",
            error: undefined,
            recoveryPrompt: undefined,
            delivered: true,
            activeDispatchId: undefined,
            acceptedDispatchId: undefined,
            // WP-91: the word was about the turn that ran, not this one. A fresh turn is checked again when it ends,
            // and until then the task has no gate result rather than a stale pass.
            gateOutcome: undefined,
          },
          { taskId: target.id, status: "queued" },
        );
      }
      case "retry": {
        const target = task();
        if (activeTask(target) || target.status === "queued")
          throw new Error(
            `Wait for this worker or cancel it before retrying; ${target.title} is ${target.status}.`,
          );
        if (
          run.tasks.some(
            (entry) =>
              entry.dependsOn.includes(target.id) &&
              entry.status !== "queued" &&
              entry.status !== "cancelled",
          )
        )
          throw new Error(
            "A dependent task has already started; create a separate correction task after it finishes",
          );
        const files = strings(input.files, "files");
        if (!files.length)
          throw new Error(
            "Declare at least one corrected project-relative file/directory scope, or '.' for the whole checkout",
          );
        const current = this.run(run.leadId)!;
        const scopes = await this.store.scopes(
          orchestrationCheckoutCwd(current),
          files,
        );
        return changeTask(
          target.id,
          {
            prompt: text(input.text, "text"),
            files,
            scopes,
            writeScopes: undefined,
            status: "queued",
            accepted: false,
            result: "",
            error: undefined,
            recoveryPrompt: undefined,
            delivered: true,
            activeDispatchId: undefined,
            acceptedDispatchId: undefined,
            // WP-91: the word was about the turn that ran, not this one. A fresh turn is checked again when it ends,
            // and until then the task has no gate result rather than a stale pass.
            gateOutcome: undefined,
          },
          { taskId: target.id, status: "queued", files },
        );
      }
      case "steer": {
        const target = task();
        if (target.status !== "running")
          throw new Error(
            `Only a running agent can be steered; ${target.title} is ${target.status}. ${
              target.status === "queued"
                ? "It has not started yet, so edit it with message instead."
                : "Send it a fresh turn with message."
            }`,
          );
        const guidance = text(input.text, "text");
        await this.host!.steer(target.sessionId, guidance);
        return record(this.run(run.leadId)!, {
          taskId: target.id,
          steered: true,
        });
      }
      case "cancel":
        await this.cancelTask(run.leadId, task().id);
        return record(this.run(run.leadId)!, { cancelled: true });
      case "respond": {
        const target = task();
        const pending = this.pendingInput(target);
        if (pending?.kind !== "approval")
          throw new Error(
            `${target.title} is not waiting on an approval. Read needsInput from list or wait before responding.`,
          );
        if (input.requestId !== pending.requestId)
          throw new Error(
            `Stale requestId. ${target.title} is waiting on ${pending.requestId}.`,
          );
        const decision = text(input.decision, "decision", 16);
        if (decision !== "allow" && decision !== "deny")
          throw new Error('decision must be "allow" or "deny"');
        this.host!.respondApproval(
          target.sessionId,
          pending.requestId,
          decision,
        );
        return record(this.run(run.leadId)!, {
          taskId: target.id,
          decision,
        });
      }
      case "answer": {
        const target = task();
        const pending = this.pendingInput(target);
        if (pending?.kind !== "question")
          throw new Error(
            `${target.title} is not waiting on a question. Read needsInput from list or wait before answering.`,
          );
        if (input.requestId !== pending.requestId)
          throw new Error(
            `Stale requestId. ${target.title} is waiting on ${pending.requestId}.`,
          );
        const reply: UserQuestionReply =
          input.skip === true
            ? { kind: "skipped" }
            : {
                kind: "answered",
                answers: questionAnswers(input.answers, pending.questions),
              };
        this.host!.answerQuestion(target.sessionId, pending.requestId, reply);
        return record(this.run(run.leadId)!, {
          taskId: target.id,
          answered: reply.kind === "answered",
        });
      }
      case "review": {
        let target = task();
        if (target.status !== "completed")
          throw new Error(
            `Only a completed result can be accepted; ${target.title} is ${target.status}. ${
              ["failed", "blocked", "interrupted"].includes(target.status)
                ? "Send it another turn with message, retry it with corrected scope when necessary, or drop it with cancel."
                : "Wait for it to finish, or cancel it."
            }`,
          );
        const dispatchId = target.lastDispatchId;
        if (!dispatchId)
          throw new Error("This task has no completed dispatch to review");
        const isolated = target.workspacePolicy !== "shared";
        if (!target.accepted) {
          // WP-91: a handoff for every node. Acceptance reads it once from the worker's own checkout — proving it
          // exists and is inside that checkout, and recording its path and digest — and refuses the task when it is
          // missing. `get` reads it too, so a lead can open a handoff early; either way the record says it was
          // opened, which is all the app can prove.
          const handoff = await this.readHandoff(target);
          if (handoff.refusal)
            throw new Error(
              `${handoff.refusal.message} Ask ${target.title} for its handoff with message, or correct it with retry.`,
            );
          if (isolated) {
            if (!target.workspace)
              throw new Error(
                "This worker's isolated checkout is unavailable. Its changes were not accepted.",
              );
            await this.patchDispatch(run.leadId, dispatchId, {
              stage: "integration_started",
              cleanupError: undefined,
            });
            await this.host!.integrateWorker(this.run(run.leadId)!, target);
          }
          const current = this.run(run.leadId)!;
          const recorded = handoff.handoff;
          await this.commit({
            ...current,
            tasks: current.tasks.map((entry) =>
              entry.id === target.id
                ? {
                    ...entry,
                    accepted: true,
                    acceptedDispatchId: dispatchId,
                    ...(recorded
                      ? {
                          handoff: {
                            path: recorded.path,
                            sha256: recorded.sha256,
                            bytes: recorded.bytes,
                            read: true,
                            at: entry.handoff?.at ?? Date.now(),
                          },
                        }
                      : {}),
                  }
                : entry,
            ),
            dispatches: (current.dispatches ?? []).map((dispatch) =>
              dispatch.id === dispatchId
                ? {
                    ...dispatch,
                    stage: isolated ? "integrated" : dispatch.stage,
                    updatedAt: Date.now(),
                  }
                : dispatch,
            ),
          });
          target = this.run(run.leadId)!.tasks.find(
            (entry) => entry.id === target.id,
          )!;
          // WP-91: accepting a repair of the run's verify task puts the verification back in the queue. It is the
          // verification that says the goal holds, not the repair that fixed what it found (`reruns_root`).
          await this.requeueRepairedVerification(run.leadId, target.id);
          target = this.run(run.leadId)!.tasks.find(
            (entry) => entry.id === target.id,
          )!;
        }

        let cleaned = !isolated;
        let cleanupError: string | undefined;
        if (isolated) {
          try {
            cleaned = await this.host!.cleanupWorker(
              this.run(run.leadId)!,
              target,
              false,
            );
          } catch (error) {
            cleanupError = messageOf(error);
          }
          const current = this.run(run.leadId)!;
          await this.commit({
            ...current,
            tasks: current.tasks.map((entry) =>
              entry.id === target.id && cleaned
                ? { ...entry, workspace: undefined }
                : entry,
            ),
            dispatches: (current.dispatches ?? []).map((dispatch) =>
              dispatch.id === dispatchId
                ? {
                    ...dispatch,
                    ...(cleaned ? { stage: "cleaned" as const } : {}),
                    cleanupError,
                    updatedAt: Date.now(),
                  }
                : dispatch,
            ),
          });
        }
        const answered = await record(this.run(run.leadId)!, {
          accepted: true,
          integrated: isolated,
          cleaned,
          ...(cleanupError ? { cleanupError } : {}),
        });
        // Every acceptance can change the run's verdict, so the rules answer again; the card and the lead read the
        // stored report rather than each deciding for itself.
        const report = await this.refreshGoalReport(run.leadId);
        void this.pump();
        this.sync();
        return {
          ...(answered as Record<string, unknown>),
          ...(report
            ? { goal: { verdict: report.verdict, reasons: report.reasons } }
            : {}),
        };
      }
      case "repair": {
        const target = task();
        if (target.status !== "failed" && target.status !== "blocked")
          throw new Error(
            `Only a failed or blocked task is repaired; ${target.title} is ${target.status}. ${
              target.status === "cancelled"
                ? "A cancelled task is not repaired: delegate a new one."
                : "Wait for it to finish, or cancel it."
            }`,
          );
        const root = target.repairs ?? target.id;
        const cycles = this.run(run.leadId)!.repairCycles?.[root] ?? [];
        const left = this.run(run.leadId)!.goalReport?.cyclesLeft?.[root];
        if (typeof left === "number" ? left <= 0 : cycles.length >= MAX_REPAIR_CYCLES)
          throw new Error(
            `${target.title} has had ${MAX_REPAIR_CYCLES} repair cycles. Report what is still open instead of repairing again, or delegate a new task for the rest.`,
          );
        // A repair of a verification fixes work, so it declares what it will write: the verification's own scope is
        // empty (it checks and writes a report), and a build task with no scope would start with nothing to do.
        const files = input.files == null ? target.files : strings(input.files, "files");
        if (!files.length)
          throw new Error(
            target.role === "verify"
              ? "This repairs a check, so name the project files the fix writes (or '.' for the whole checkout)."
              : "Declare at least one corrected project-relative file/directory scope, or '.' for the whole checkout",
          );
        const current = this.run(run.leadId)!;
        if (current.tasks.length >= 40)
          throw new Error("This run has reached its 40-task limit");
        const scopes = await this.store.scopes(
          orchestrationCheckoutCwd(current),
          files,
        );
        const replan = cycles.length + 1 >= REPLAN_CYCLE;
        // Only the failed task's dependencies that were accepted, so an independent branch keeps running and the
        // repair never waits on a task that will not run. The failed task itself is settled by the repair, never a
        // dependency of it (`repair_depends_on_open_node`).
        const dependsOn = target.dependsOn.filter(
          (id) => current.tasks.find((entry) => entry.id === id)?.accepted,
        );
        // A repair of the run's verify task is a build task that fixes what the verification found. The verification
        // itself goes back in the queue when the repair is accepted (`reruns_root`), so a repair is never a second
        // verifier and never needs to be one: a verification is checked by running again, not by being replaced.
        const role: "build" | "verify" = "build";
        const id = crypto.randomUUID();
        const created: OrchestrationTask = {
          id,
          sessionId: crypto.randomUUID(),
          title: text(input.title, "title", 160),
          // The re-plan is a re-plan: say what failed before, so the worker does not repeat it.
          prompt: `${text(input.prompt, "prompt")}${
            replan
              ? `\n\nThis is the second repair of the same task, so treat it as a re-plan rather than another try: the earlier attempts did not work. What failed before:\n${(target.error ?? target.result).slice(-2000)}`
              : ""
          }`,
          files,
          scopes,
          dependsOn,
          role,
          harness: target.harness,
          model: target.model,
          ...(target.modelSettings ? { modelSettings: target.modelSettings } : {}),
          status: "queued",
          accepted: false,
          result: "",
          delivered: true,
          workspacePolicy: "isolated-child",
          repairs: root,
          cycle: cycles.length + 1,
        };
        // The graph's own rule for a repair, before it joins the record: its dependencies, its cycle cap, and the
        // scopes it shares with everything that can still run. It may write what the task it repairs wrote.
        try {
          await this.goals.checkRepair(goalRunView(current), {
            id,
            title: created.title,
            role,
            dependsOn,
            writeScope: files,
            repairs: root,
          });
        } catch (error) {
          throw new Error(refusalMessage(error));
        }
        const cyclesTaken: Record<string, string[][]> = {
          ...(this.run(run.leadId)!.repairCycles ?? {}),
        };
        // One repair cycle per repair: a new entry, never a bigger cycle.
        cyclesTaken[root] = [...cycles, [created.id]];
        const next: OrchestrationRun = {
          ...this.run(run.leadId)!,
          tasks: [...this.run(run.leadId)!.tasks, created],
          repairCycles: cyclesTaken,
        };
        const result = await record(next, {
          taskId: created.id,
          sessionId: created.sessionId,
          status: "queued",
          repairs: root,
          cycle: created.cycle,
          replan,
        });
        void this.pump();
        void this.refreshGoalReport(run.leadId);
        return result;
      }
      case "approve": {
        const target = task();
        if (!target.irreversible)
          throw new Error(
            `${target.title} is an ordinary task: it starts on its own and the person never approves it.`,
          );
        if (target.irreversibleAnswered)
          throw new Error(`${target.title}'s irreversible step was already approved.`);
        const state = await this.gateIrreversible(run.leadId, target);
        const latest = this.run(run.leadId)!.tasks.find(
          (entry) => entry.id === target.id,
        )!;
        if (state === "wait")
          return {
            taskId: target.id,
            parked: true,
            answered: false,
            say: `Waiting for the person to approve or send back: ${latest.irreversibleReason ?? "it cannot be undone"}. It is in Needs. Only the person answers this one; the app will not.`,
          };
        if (state === "sent-back")
          return {
            taskId: target.id,
            parked: false,
            answered: true,
            sentBack: true,
            taskStatus: latest.status,
            error: latest.error,
          };
        void this.pump();
        return { taskId: target.id, parked: false, answered: true, dispatched: true };
      }
      case "finish": {
        const outstanding = this.run(run.leadId)!.tasks.filter(
          (entry) => entry.status !== "cancelled" && !entry.accepted,
        );
        if (outstanding.length)
          throw new Error(
            `Review all remaining tasks before finishing. Outstanding: ${listed(
              outstanding.map((entry) => `${entry.title} (${entry.status})`),
            )}. Accept a completed task with review, correct a failed or blocked task with message/retry, or drop it with cancel.`,
          );
        // WP-91: the app runs the finish line itself, in the integrated lead checkout, after the last acceptance.
        // The verdict comes from the record and this run, never from anything an agent said. A run that names no
        // finish line is one that predates WP-91 (resumed from a saved record): it finishes as it did before, and
        // its report says plainly that nothing was proved.
        if (this.run(run.leadId)!.check) {
          await this.runGoalCheck(
            run.leadId,
            orchestrationCheckoutCwd(this.run(run.leadId)!),
            "app",
          );
          const report = await this.refreshGoalReport(run.leadId);
          if (!report)
            throw new Error(
              "The goal graph could not be read, so the run cannot be called done.",
            );
          if (report.verdict !== "verified")
            throw new Error(
              `The goal is not proved yet: ${describeGoalReport(report)} Fix what is named, then finish again. A check that could not run is not a pass.`,
            );
        }
        const cleanupPending: string[] = [];
        for (const retained of this.run(run.leadId)!.tasks.filter(
          (entry) => entry.workspacePolicy !== "shared" && entry.workspace,
        )) {
          if (!retained.accepted) {
            const cleaned = await this.cleanupUnchangedWorker(
              run.leadId,
              retained.id,
            );
            if (!cleaned) cleanupPending.push(retained.workspace!.checkoutCwd);
            continue;
          }
          const dispatchId = retained.acceptedDispatchId;
          const dispatch = this.run(run.leadId)!.dispatches?.find(
            (entry) => entry.id === dispatchId,
          );
          if (dispatch?.stage === "cleaned") continue;
          try {
            const cleaned = await this.host!.cleanupWorker(
              this.run(run.leadId)!,
              retained,
              false,
            );
            if (cleaned) {
              const current = this.run(run.leadId)!;
              await this.commit({
                ...current,
                tasks: current.tasks.map((entry) =>
                  entry.id === retained.id
                    ? { ...entry, workspace: undefined }
                    : entry,
                ),
                dispatches: (current.dispatches ?? []).map((entry) =>
                  entry.id === dispatchId
                    ? {
                        ...entry,
                        stage: "cleaned",
                        cleanupError: undefined,
                        updatedAt: Date.now(),
                      }
                    : entry,
                ),
              });
            } else cleanupPending.push(retained.workspace!.checkoutCwd);
          } catch (error) {
            cleanupPending.push(retained.workspace!.checkoutCwd);
            if (dispatchId)
              await this.patchDispatch(run.leadId, dispatchId, {
                cleanupError: messageOf(error),
              });
          }
        }
        const current = this.run(run.leadId)!;
        // WP-148: the close counts what the children had recorded. A session that cannot be read is left out, never
        // stored as zero, and never stops the run from finishing.
        const closingUsage = sumChildUsage(
          current.tasks.map((task) => {
            let usage: ReturnType<typeof usageFromSession>;
            try {
              usage = usageFromSession(this.host?.session(task.sessionId));
            } catch {
              usage = undefined;
            }
            return { sessionId: task.sessionId, usage };
          }),
        );
        const result = await record(
          {
            ...current,
            status: "finished",
            closingUsage,
          },
          {
            finished: true,
            ...(closingUsage ? { usage: closingUsage } : {}),
            ...(cleanupPending.length ? { cleanupPending } : {}),
          },
        );
        await this.store.disable(run.leadId);
        return result;
      }
      default:
        throw new Error("Unknown action. Run control --help.");
    }
  }
  private async wait(leadId: string, input: Record<string, unknown>) {
    const run = this.run(leadId);
    if (!run) throw new Error("No orchestration run was found for this lead");
    const seconds = input.timeoutSeconds ?? 20;
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > 25
    )
      throw new Error("timeoutSeconds must be 0 to 25");
    // A worker blocking on the lead changes no run state, so watch for that
    // separately; otherwise the lead sleeps while an agent waits on it.
    const blocked = this.blocked.get(leadId);
    // Input that arrived before `wait` is already actionable. Only long-poll
    // while every running worker can still make progress without the lead.
    if (
      run.status === "active" &&
      this.blockedKeys(run).length === 0 &&
      (run.tasks.some(activeTask) ||
        run.tasks.some((task) => task.status === "queued"))
    ) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const unsubscribe = this.subscribe(() => {
          if (this.run(leadId) !== run || this.blocked.get(leadId) !== blocked)
            finish();
        });
        const timer = setTimeout(finish, seconds * 1000);
      });
    }
    return this.view(this.run(leadId)!);
  }
  private async pump() {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    if (!this.host) return;
    this.pumping = true;
    try {
      for (const initial of this.runs) {
        const initialRun = this.run(initial.leadId);
        if (!initialRun || initialRun.status !== "active") continue;
        for (const initialTask of initialRun.tasks) {
          let run = this.run(initial.leadId);
          if (
            !run ||
            run.status !== "active" ||
            run.tasks.filter(activeTask).length >= run.maxWorkers
          )
            break;
          const stable = run;
          let task = stable.tasks.find((entry) => entry.id === initialTask.id);
          if (
            !task ||
            task.status !== "queued" ||
            // A dependency is settled when it was accepted, or when an accepted repair stands in for it: that is
            // how the rules read a repaired task, and how a repaired root lets its dependents run.
            task.dependsOn.some((id) => {
              const parent = stable.tasks.find((entry) => entry.id === id);
              if (!parent) return true;
              if (parent.accepted) return false;
              return !stable.tasks.some(
                (entry) =>
                  entry.repairs === id &&
                  entry.accepted &&
                  entry.status !== "cancelled",
              );
            })
          )
            continue;
          // WP-91: an irreversible step waits for the person's decision before any checkout or process is made, and
          // the question is raised as soon as its task is ready rather than when a worker slot frees up.
          if (task.irreversible && !task.irreversibleAnswered) {
            const gate = await this.gateIrreversible(run.leadId, task);
            if (gate === "sent-back") {
              void this.refreshGoalReport(run.leadId);
              continue;
            }
            if (gate === "wait") {
              this.sync();
              continue;
            }
            // The decision may have taken minutes: read the run again and dispatch only a task that is still waiting
            // in a run that is still going. A person can cancel this task while the gate is open.
            const fresh = this.run(run.leadId);
            const freshTask = fresh?.tasks.find(
              (entry) => entry.id === initialTask.id,
            );
            if (
              !fresh ||
              fresh.status !== "active" ||
              !freshTask ||
              freshTask.status !== "queued"
            )
              continue;
            run = fresh;
            task = freshTask;
          }
          if (
            run.tasks.some(
              (entry) =>
                activeTask(entry) && scopesOverlap(entry.scopes, task.scopes),
            )
          )
            continue;
          if (!this.host.session(run.leadId)) {
            await this.stopRun(run.leadId);
            break;
          }
          const retryAt = task.poolRetryAt;
          if (
            typeof retryAt === "number" &&
            Number.isFinite(retryAt) &&
            retryAt > Date.now()
          ) {
            this.schedulePoolWake(retryAt);
            continue;
          }
          const dispatchId = crypto.randomUUID();
          const now = Date.now();
          const dispatch: OrchestrationDispatch = {
            id: dispatchId,
            taskId: task.id,
            sessionId: task.sessionId,
            workspace: orchestrationWorkspace(run),
            state: "starting",
            stage: "accepted",
            startedAt: now,
            updatedAt: now,
          };
          // Persist authority before any external worker/resource operation. Read the run again here: a delegate,
          // a repair or the goal graph's report may have written the record since this pass started, and that
          // newer snapshot is the one the dispatch belongs in. Only a task that is still queued in a run that is
          // still going may be stamped running: anything else (cancelled, paused, already dispatched) wins.
          const dispatching = this.run(run.leadId) ?? run;
          const live = dispatching.tasks.find((entry) => entry.id === task.id);
          if (
            dispatching.status !== "active" ||
            !live ||
            live.status !== "queued"
          )
            continue;
          await this.commit({
            ...dispatching,
            tasks: dispatching.tasks.map((entry) =>
              entry.id === task.id
                ? {
                    ...entry,
                    status: "running",
                    activeDispatchId: dispatchId,
                    acceptedDispatchId: undefined,
                    poolNote: undefined,
                    poolRetryAt: undefined,
                  }
                : entry,
            ),
            dispatches: [...(dispatching.dispatches ?? []), dispatch],
          });
          this.writeChecks.set(dispatchId, new Set());
          try {
            if (
              !this.host
                .choices()
                .some(
                  (choice) =>
                    choice.harness === task.harness &&
                    choice.models.some((model) => model.id === task.model),
                )
            )
              throw new Error(
                "The assigned harness/model is no longer available. Review this task before retrying.",
              );
            const activeRun = this.run(run.leadId)!;
            const activeTask = activeRun.tasks.find(
              (entry) => entry.id === task.id,
            )!;
            const prepared = await this.host.createWorker(
              activeRun,
              activeTask,
            );
            if (
              this.run(run.leadId)?.status !== "active" ||
              this.run(run.leadId)?.tasks.find((entry) => entry.id === task.id)
                ?.status !== "running"
            )
              continue;
            const writeScopes = await this.store.scopes(
              prepared.workspace.checkoutCwd,
              task.files,
            );
            // Read the run again after that await: a delegate, a repair or the goal graph's report may have written
            // the record while the scopes were resolving, and writing the older snapshot back would drop it.
            const preparedRun = this.run(run.leadId)!;
            await this.commit({
              ...preparedRun,
              tasks: preparedRun.tasks.map((entry) =>
                entry.id === task.id
                  ? {
                      ...entry,
                      workspace: prepared.workspace,
                      scratchDir: prepared.scratchDir,
                      writeScopes,
                    }
                  : entry,
              ),
              dispatches: (preparedRun.dispatches ?? []).map((entry) =>
                entry.id === dispatchId
                  ? {
                      ...entry,
                      workspace: prepared.workspace,
                      stage: "session_prepared",
                      updatedAt: Date.now(),
                    }
                  : entry,
              ),
            });
            if (
              this.run(run.leadId)?.status !== "active" ||
              this.run(run.leadId)?.tasks.find((entry) => entry.id === task.id)
                ?.status !== "running"
            )
              continue;
            // WP-91: the accepted tasks this one waits on, by handoff path only; the worker reads them itself.
            const acceptedBefore = this.run(run.leadId)!
              .tasks.filter(
                (entry) =>
                  task.dependsOn.includes(entry.id) &&
                  entry.accepted &&
                  entry.handoff?.path,
              )
              .map((entry) => entry.handoff!.path);
            const prompt = workerTurnPrompt(
              task.recoveryPrompt ?? task.prompt,
              task.files,
              prepared.scratchDir,
              // WP-91: a handoff for every node, so the next node and the person's review have something to read.
              handoffRelativePath(task.id),
              acceptedBefore,
            );
            this.host.submit(task.sessionId, prompt, (outcome) => {
              void this.settle(run.leadId, task.id, outcome, dispatchId).catch(
                console.error,
              );
            });
            if (
              this.run(run.leadId)?.tasks.find((entry) => entry.id === task.id)
                ?.activeDispatchId === dispatchId
            )
              await this.patchDispatch(run.leadId, dispatchId, {
                state: "running",
                stage: "turn_submitted",
              });
          } catch (error) {
            const message = messageOf(error);
            if (message.startsWith("pool-full: ")) {
              await this.holdForFullPool(
                run.leadId,
                task.id,
                dispatchId,
                message,
              );
              continue;
            }
            await this.settle(
              run.leadId,
              task.id,
              {
                status: "failed",
                text: "",
                error: message,
              },
              dispatchId,
            );
          }
        }
      }
    } catch (error) {
      console.error("Orchestration dispatch failed", error);
    } finally {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        void this.pump();
      }
    }
  }
  /**
   * A full worktree pool is a wait, not a failure. Put the task back on the
   * queue and wake once; do not start it again in this pump pass.
   */
  private async holdForFullPool(
    leadId: string,
    taskId: string,
    dispatchId: string,
    message: string,
  ) {
    const note = message.slice("pool-full: ".length).trim();
    const poolNote =
      note ||
      "Waiting for a free worktree. The pool for this project is full.";
    const poolRetryAt = Date.now() + 5_000;
    const current = this.run(leadId);
    const currentTask = current?.tasks.find((entry) => entry.id === taskId);
    if (
      !current ||
      currentTask?.status !== "running" ||
      currentTask.activeDispatchId !== dispatchId
    )
      return;
    await this.commit({
      ...current,
      tasks: current.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              status: "queued",
              activeDispatchId: undefined,
              poolNote,
              poolRetryAt,
            }
          : entry,
      ),
      dispatches: (current.dispatches ?? []).map((dispatch) =>
        dispatch.id === dispatchId
          ? {
              ...dispatch,
              state: "cancelled",
              stage: "settled",
              updatedAt: Date.now(),
            }
          : dispatch,
      ),
    });
    this.writeChecks.delete(dispatchId);
    this.schedulePoolWake(poolRetryAt);
  }
  /** Keep the soonest pool wake. A later request must not postpone it. */
  private schedulePoolWake(at: number) {
    if (this.poolWake && this.poolWake.at <= at) return;
    if (this.poolWake) clearTimeout(this.poolWake.timer);
    const timer = setTimeout(() => {
      if (this.poolWake?.timer === timer) this.poolWake = null;
      void this.pump();
    }, Math.max(0, at - Date.now()));
    this.poolWake = { at, timer };
  }
  private async settle(
    leadId: string,
    taskId: string,
    outcome: ControlOutcome,
    dispatchId: string,
  ) {
    let task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (!task || task.activeDispatchId !== dispatchId) return;
    if (task?.status === "cancelling") {
      if (outcome.text)
        await this.patchTask(leadId, taskId, {
          result: outcome.text.slice(-20_000),
        });
      return;
    }
    if (task.status !== "running") return;
    // A fast final response must not make an unchecked write reviewable.
    await Promise.all(this.writeChecks.get(dispatchId) ?? []);
    task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (
      !task ||
      task.status !== "running" ||
      task.activeDispatchId !== dispatchId
    )
      return;
    this.writeChecks.delete(dispatchId);
    // WP-91: WP-40's check on this worker's own copy, once its turn is in and before anything can be accepted. A
    // check that could not run is `notRun`, never a pass, and a project with no check records no word at all; either
    // way the verdict says which accepted tasks no gate checked rather than counting their silence as one.
    let gateOutcome: OrchestrationTask["gateOutcome"];
    if (this.host?.gateWorker && outcome.status === "completed") {
      try {
        gateOutcome =
          (await this.host.gateWorker(this.run(leadId)!, task)) ?? undefined;
      } catch {
        // The check itself failed to answer: that is a gate that could not run, not a task failure.
        gateOutcome = "notRun";
      }
      task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    }
    if (
      !task ||
      task.status !== "running" ||
      task.activeDispatchId !== dispatchId
    )
      return;
    const run = this.run(leadId)!;
    await this.commit({
      ...run,
      tasks: run.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              status: outcome.status,
              result: outcome.text.slice(-20_000),
              error: outcome.error,
              recoveryPrompt: undefined,
              delivered: false,
              accepted: false,
              activeDispatchId: undefined,
              lastDispatchId: dispatchId,
              ...(gateOutcome ? { gateOutcome } : { gateOutcome: undefined }),
            }
          : entry,
      ),
      dispatches: (run.dispatches ?? []).map((dispatch) =>
        dispatch.id === dispatchId
          ? {
              ...dispatch,
              state: outcome.status,
              stage: "settled",
              updatedAt: Date.now(),
              result: outcome.text.slice(-20_000),
              error: outcome.error,
            }
          : dispatch,
      ),
    });
    if (outcome.status === "failed")
      await this.cleanupUnchangedWorker(leadId, taskId);
    void this.refreshGoalReport(leadId);
    void this.pump();
    this.sync();
  }
  async cancelTask(leadId: string, taskId: string) {
    const task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (!task || task.status === "cancelled") return;
    const dispatchId = task.activeDispatchId;
    if (activeTask(task)) {
      await this.patchTask(leadId, taskId, {
        status: "cancelling",
      });
      await this.host!.stop(task.sessionId);
    }
    const run = this.run(leadId);
    if (!run) return;
    await this.commit({
      ...run,
      tasks: run.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              status: "cancelled",
              accepted: false,
              delivered: false,
              activeDispatchId: undefined,
              recoveryPrompt: undefined,
              ...(dispatchId ? { lastDispatchId: dispatchId } : {}),
            }
          : entry,
      ),
      dispatches: (run.dispatches ?? []).map((dispatch) =>
        dispatch.id === dispatchId
          ? {
              ...dispatch,
              state: "cancelled",
              stage: "settled",
              updatedAt: Date.now(),
            }
          : dispatch,
      ),
    });
    if (dispatchId) this.writeChecks.delete(dispatchId);
    await this.cleanupUnchangedWorker(leadId, taskId);
    void this.refreshGoalReport(leadId);
    void this.pump();
  }
  private async interruptTask(leadId: string, taskId: string, reason: string) {
    const task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (!task || task.status !== "running") return;
    const dispatchId = task.activeDispatchId;
    await this.patchTask(leadId, taskId, {
      status: "cancelling",
      error: reason,
    });
    await this.host!.stop(task.sessionId);
    const run = this.run(leadId);
    if (!run) return;
    await this.commit({
      ...run,
      tasks: run.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              status: "interrupted",
              accepted: false,
              delivered: true,
              activeDispatchId: undefined,
              error: reason,
              recoveryPrompt: recoveryTurn(reason),
              ...(dispatchId ? { lastDispatchId: dispatchId } : {}),
            }
          : entry,
      ),
      dispatches: (run.dispatches ?? []).map((dispatch) =>
        dispatch.id === dispatchId
          ? {
              ...dispatch,
              state: "interrupted",
              stage: "settled",
              updatedAt: Date.now(),
              error: reason,
            }
          : dispatch,
      ),
    });
    if (dispatchId) this.writeChecks.delete(dispatchId);
  }
  private async blockTask(leadId: string, taskId: string, reason: string) {
    const task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (!task || task.status !== "running") return;
    const dispatchId = task.activeDispatchId;
    await this.patchTask(leadId, taskId, {
      status: "cancelling",
      error: reason,
    });
    await this.host!.stop(task.sessionId);
    const run = this.run(leadId);
    if (!run) return;
    await this.commit({
      ...run,
      tasks: run.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              status: "blocked",
              accepted: false,
              delivered: false,
              activeDispatchId: undefined,
              error: reason,
              recoveryPrompt: undefined,
              ...(dispatchId ? { lastDispatchId: dispatchId } : {}),
            }
          : entry,
      ),
      dispatches: (run.dispatches ?? []).map((dispatch) =>
        dispatch.id === dispatchId
          ? {
              ...dispatch,
              state: "blocked",
              stage: "settled",
              updatedAt: Date.now(),
              error: reason,
            }
          : dispatch,
      ),
    });
    if (dispatchId) this.writeChecks.delete(dispatchId);
    void this.pump();
    this.sync();
  }
  /**
   * A paused run has no supervisor, so its agents stop with it. Leaving them
   * editing with nobody reviewing is how a run quietly diverges from what the
   * user approved. Their worktrees are retained. Queued work is left alone: `pump`
   * will not dispatch while paused, so it resumes intact.
   */
  private async pause(
    leadId: string,
    error: string,
    patch?: (run: OrchestrationRun) => OrchestrationRun,
  ) {
    const run = this.run(leadId);
    if (!run || run.status !== "active") return;
    await this.commit({
      ...(patch ? patch(run) : run),
      status: "paused",
      error,
      lastPauseReason: error,
    });
    // Serialize state transitions: parallel commits here can resurrect an
    // already-stopped worker from an older snapshot.
    for (const task of this.run(leadId)!.tasks.filter(
      (entry) => entry.status === "running",
    ))
      await this.interruptTask(leadId, task.id, error);
  }
  async stopRun(leadId: string) {
    const run = this.run(leadId);
    if (!run) return;
    let saveError: unknown;
    await this.commit({ ...run, status: "stopped" }).catch((error: unknown) => {
      saveError = error;
    });
    await Promise.all(
      [
        leadId,
        ...run.tasks.filter(activeTask).map((task) => task.sessionId),
      ].map((id) => this.host?.stop(id)),
    );
    const latest = this.run(leadId)!;
    const stopped: OrchestrationRun = {
      ...latest,
      status: "stopped",
      tasks: latest.tasks.map((task) =>
        activeTask(task) || task.status === "queued"
          ? {
              ...task,
              status: "cancelled",
              accepted: false,
              delivered: true,
              activeDispatchId: undefined,
              ...(task.activeDispatchId
                ? { lastDispatchId: task.activeDispatchId }
                : {}),
            }
          : task,
      ),
      dispatches: (latest.dispatches ?? []).map((dispatch) =>
        latest.tasks.some(
          (task) => task.activeDispatchId === dispatch.id && activeTask(task),
        )
          ? {
              ...dispatch,
              state: "cancelled",
              stage: "settled",
              updatedAt: Date.now(),
            }
          : dispatch,
      ),
    };
    for (const task of latest.tasks) {
      if (task.activeDispatchId) this.writeChecks.delete(task.activeDispatchId);
    }
    await this.commit(stopped).catch((error: unknown) => {
      saveError = error;
    });
    if (!saveError) {
      for (const task of stopped.tasks.filter((entry) => !entry.accepted))
        await this.cleanupUnchangedWorker(leadId, task.id);
    }
    const afterCleanup = this.run(leadId) ?? stopped;
    this.runs = this.runs.map((entry) =>
      entry.leadId === leadId
        ? {
            ...afterCleanup,
            error: saveError
              ? `Run stopped; could not save history: ${messageOf(saveError)}`
              : afterCleanup.error,
          }
        : entry,
    );
    this.emit();
    await this.store.disable(leadId);
  }
  /** WP-91: check a plan's graph before anything runs; the refusal is the person's to read. */
  async checkPlan(nodes: ReturnType<typeof goalPlanNodes>) {
    return await this.goals.checkPlan(nodes);
  }
  /**
   * WP-91: a decision was answered somewhere in the app. A run with an irreversible step parked on one starts it
   * again the moment the person says so, without waiting for the lead or a reload.
   */
  decisionsChanged() {
    const parked = this.runs.some(
      (run) =>
        run.status === "active" &&
        run.tasks.some((task) => task.irreversible && task.status === "queued"),
    );
    if (parked) void this.pump();
  }
  stopForSession(id: string): Promise<void> | null {
    const run = this.forSession(id);
    if (
      !run ||
      (run.status !== "active" &&
        run.status !== "paused" &&
        !run.tasks.some(activeTask))
    )
      return null;
    if (run.leadId === id) return this.stopRun(id);
    const task = run.tasks.find((entry) => entry.sessionId === id)!;
    return this.cancelTask(run.leadId, task.id);
  }
  /** Drain control writes before the database removes a lead or one of its workers. */
  deleteSession(id: string, remove: () => Promise<void>): Promise<void> {
    const result = this.actions
      .catch(() => undefined)
      .then(async () => {
        const run = this.forSession(id);
        if (
          run &&
          (run.status === "active" ||
            run.status === "paused" ||
            run.tasks.some(activeTask))
        ) {
          await this.stopRun(run.leadId);
        }
        await this.saves.catch(() => undefined);
        await remove();
        this.deleted.add(id);
        if (!run) return;
        this.runs = this.runs.filter((entry) => entry.leadId !== run.leadId);
        this.persisted.delete(run.leadId);
        this.blocked.delete(run.leadId);
        this.announced.delete(run.leadId);
        this.emit();
        if (run.leadId !== id) {
          // Read the transaction's pruned graph; never save the pre-delete snapshot.
          const updated = await this.store.load(run.leadId).catch((error) => {
            console.error(
              "Could not reload orchestration after deletion",
              error,
            );
            this.loaded.delete(run.leadId);
            return null;
          });
          if (updated) {
            const normalized = normalizeOrchestrationRun(updated);
            this.runs = [...this.runs, normalized];
            this.persisted.set(run.leadId, normalized);
            this.emit();
          }
        }
      });
    this.actions = result.catch(() => undefined);
    return result;
  }
  /** `${taskId}:${requestId}` for every worker currently blocked on the lead. */
  private blockedKeys(run: OrchestrationRun): string[] {
    return run.tasks.flatMap((task) => {
      const pending = this.pendingInput(task);
      return pending ? [`${task.id}:${pending.requestId}`] : [];
    });
  }
  sync() {
    for (const run of this.runs) {
      if (run.status !== "active") continue;
      // A blocked worker changes no run state, so `wait` needs telling.
      const keys = this.blockedKeys(run).join(",");
      if (this.blocked.get(run.leadId) !== keys) {
        this.blocked.set(run.leadId, keys);
        this.emit();
      }
    }
    for (const run of this.runs) {
      if (run.status !== "active" || this.waking.has(run.leadId)) continue;
      const lead = this.host?.session(run.leadId);
      if (!lead || lead.busy || lead.queuedMessages?.length) continue;
      const announced = this.announced.get(run.leadId) ?? new Set<string>();
      const results = run.tasks.filter((task) => !task.delivered);
      const blocked = this.blockedKeys(run).filter(
        (key) => !announced.has(key),
      );
      if (!results.length && !blocked.length) continue;
      this.waking.add(run.leadId);
      // Let session state settle before checking idle; never interrupt user input.
      setTimeout(() => {
        void (async () => {
          try {
            const current = this.run(run.leadId);
            const session = this.host?.session(run.leadId);
            if (
              !current ||
              current.status !== "active" ||
              !session ||
              session.busy ||
              session.queuedMessages?.length
            )
              return;
            const results = current.tasks.filter(
              (task) =>
                !task.delivered &&
                !activeTask(task) &&
                task.status !== "queued",
            );
            const seen = this.announced.get(run.leadId) ?? new Set<string>();
            const waiting = current.tasks.flatMap((task) => {
              const pending = this.pendingInput(task);
              const key = pending && `${task.id}:${pending.requestId}`;
              return key && !seen.has(key) ? [{ task, pending, key }] : [];
            });
            if (!results.length && !waiting.length) return;
            if (current.continuations >= 20) {
              await this.pause(
                run.leadId,
                "Automatic continuation limit reached. Its agents were stopped; review and resume the run.",
              );
              return;
            }
            await this.commit({
              ...current,
              continuations: current.continuations + 1,
              lastPauseReason: undefined,
              tasks: current.tasks.map((task) =>
                results.some((item) => item.id === task.id)
                  ? { ...task, delivered: true }
                  : task,
              ),
            });
            this.announced.set(
              run.leadId,
              new Set([...seen, ...waiting.map((entry) => entry.key)]),
            );
            const summary = results
              .map(
                (task) =>
                  `${task.id} — ${task.title}: ${task.status}\n${task.error ?? ""}\n${task.result.slice(-4000)}`,
              )
              .join("\n\n");
            const asks = waiting
              .map(
                ({ task, pending }) =>
                  `${task.id} — ${task.title} needs ${pending.kind === "approval" ? "an approval" : "an answer"} (requestId ${pending.requestId}): ${pending.label}\n${pending.detail?.slice(0, 2000) ?? ""}${
                    pending.questions
                      ? `\n${JSON.stringify(pending.questions)}`
                      : ""
                  }`,
              )
              .join("\n\n");
            const body = [
              current.lastPauseReason
                ? `Previous interruption: ${current.lastPauseReason}\nInterrupted workers were continued from their retained checkouts. Inspect their results normally before review. Policy-blocked tasks were not restarted; correct or explicitly re-scope those tasks before retrying them. Dependent validation remains queued until its prerequisites pass review.`
                : "",
              results.length
                ? `Worker results are ready. Review the work, request corrections through the CLI when needed, and finish the original task.\nOpen each result with get before you accept it: that reads the worker's handoff file, and a task cannot be accepted until its handoff has been opened. A failed or blocked task gets a repair with the repair action (two cycles, the second a re-plan), and only its own dependents wait.\n\n${summary}`
                : "",
              waiting.length
                ? `These agents are blocked waiting on you. Decide each one with respond or answer; they stay stopped until you do. Judge it against the task you assigned, and ask the user in this conversation only when the call is genuinely theirs to make.\n\n${asks}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n");
            this.host!.submit(run.leadId, body, (outcome) => {
              if (outcome.status !== "completed") {
                void this.pause(
                  run.leadId,
                  outcome.error ??
                    "Lead continuation was interrupted. Its agents were stopped; review and resume.",
                  (current) => ({
                    ...current,
                    tasks: current.tasks.map((task) =>
                      results.some((item) => item.id === task.id)
                        ? { ...task, delivered: false }
                        : task,
                    ),
                  }),
                ).catch(console.error);
              } else this.sync();
            });
          } catch (error) {
            console.error("Orchestration continuation failed", error);
          } finally {
            this.waking.delete(run.leadId);
          }
        })();
      }, 0);
    }
  }
  /**
   * WP-91: whether a reported write, already resolved, is this task's own handoff: `.hivra/handoff/<taskId>.md` in
   * the checkout it works in, and no other path. The checkout root is resolved and the handoff is joined to it as
   * written, so a `.hivra` or `handoff` link that leads elsewhere resolves to some other path and fails the
   * comparison, and so does another task's handoff, a file beside it or the same name in the lead's checkout.
   * Anything that cannot be resolved is not allowed.
   */
  private async isOwnHandoff(
    run: OrchestrationRun,
    task: OrchestrationTask,
    resolved: string,
  ): Promise<boolean> {
    try {
      const root = await this.store.resolvePath(
        task.workspace?.checkoutCwd ?? orchestrationCheckoutCwd(run),
      );
      return (
        orchestrationPathKey(resolved) ===
        orchestrationPathKey(`${root}/${handoffRelativePath(task.id)}`)
      );
    } catch {
      return false;
    }
  }
  observe(id: string, event: HarnessEvent) {
    if (event.type !== "tool.started" && event.type !== "tool.updated") return;
    const run = this.forSession(id);
    const task = run?.tasks.find(
      (entry) => entry.sessionId === id && entry.status === "running",
    );
    if (
      !run ||
      run.status !== "active" ||
      !task ||
      event.preview?.kind !== "write" ||
      ["failed", "error", "cancelled"].includes(event.status ?? "")
    )
      return;
    const paths =
      event.paths ?? (event.preview.path ? [event.preview.path] : []);
    const dispatchId = task.activeDispatchId;
    if (!dispatchId) return;
    const stillRunning = () =>
      this.run(run.leadId)?.status === "active" &&
      this.run(run.leadId)?.tasks.some(
        (entry) =>
          entry.id === task.id &&
          entry.status === "running" &&
          entry.activeDispatchId === dispatchId,
      );
    const checks = this.writeChecks.get(dispatchId);
    const check = (async () => {
      for (const path of paths) {
        const absolute = /^(?:[\\/]|[a-z]:[\\/])/i.test(path)
          ? path
          : `${task.workspace?.checkoutCwd ?? orchestrationCheckoutCwd(run)}/${path}`;
        let resolved: string;
        try {
          resolved = await this.store.resolvePath(absolute);
        } catch (error) {
          if (stillRunning())
            await this.blockTask(
              run.leadId,
              task.id,
              `Could not verify ${task.title}'s reported write to ${path}: ${messageOf(error)}. Only this worker was stopped and its checkout was retained. Inspect the path, then retry it with an explicit project-relative scope or cancel it.`,
            );
          return;
        }
        if (!stillRunning()) return;
        const normalized = orchestrationPathKey(resolved);
        if (
          [
            ...(task.writeScopes ?? task.scopes),
            ...(task.scratchDir ? [task.scratchDir] : []),
          ].some((scope) =>
            scopeContains(orchestrationPathKey(scope), normalized),
          )
        )
          continue;
        // WP-91: the handoff the worker was told to write is the one file outside its scope it may write.
        if (await this.isOwnHandoff(run, task, normalized)) continue;
        if (!stillRunning()) return;
        await this.blockTask(
          run.leadId,
          task.id,
          `${task.title} reported a write outside its assignment: ${path}. Only this worker was stopped and its checkout was retained; other independent work continues. Inspect the reported path. Retry with corrected project-relative files only if the write is genuinely required, otherwise send a correction within the existing scope or cancel the task.`,
        );
        return;
      }
    })().catch(console.error);
    checks?.add(check);
    void check.finally(() => checks?.delete(check));
  }
}

export const orchestrator = new Orchestrator();
