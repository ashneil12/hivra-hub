import { pathKey } from "../../../shared/lib/paths";
import type { OrchestrationChoice } from "./orchestrationPlan";
import type { HarnessId } from "../../sessions/model/session";
import { normalizeClosingUsage, type ClosingUsage } from "./closingUsage";
import {
  normalizeCheckRun,
  normalizeGoalCheck,
  normalizeGoalReport,
} from "./orchestrationGoal";
import type {
  GoalCheck,
  GoalCheckRun,
  GoalNodeReport,
  TaskHandoff,
} from "./orchestrationGoal";

export type TaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled";

export type WorkspacePolicy =
  "shared" | "isolated-child" | "isolated-top-level";

export type OrchestrationWorkspace = {
  /** Stable comparison identity; not a display path. */
  id: string;
  /** Project identity used by recents, history and project-level settings. */
  projectCwd: string;
  /** Concrete checkout in which this run may read and write. */
  checkoutCwd: string;
  kind: "main" | "worktree";
  branch?: string;
};

export type DispatchState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled"
  | "start_unknown"
  | "stop_unknown";

export type DispatchStage =
  | "accepted"
  | "session_prepared"
  | "turn_submitted"
  | "settled"
  | "integration_started"
  | "integrated"
  | "cleaned";

export type OrchestrationDispatch = {
  id: string;
  taskId: string;
  sessionId: string;
  workspace: OrchestrationWorkspace;
  state: DispatchState;
  stage: DispatchStage;
  startedAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  cleanupError?: string;
};

export type OrchestrationTask = {
  id: string;
  assignmentId?: string;
  sessionId: string;
  title: string;
  harness: HarnessId;
  model: string;
  modelSettings?: Record<string, string>;
  prompt: string;
  files: string[];
  /** Logical scopes in the lead checkout, used for scheduling overlap. */
  scopes: string[];
  /** The same scopes resolved inside this worker's isolated checkout. */
  writeScopes?: string[];
  scratchDir?: string;
  dependsOn: string[];
  status: TaskStatus;
  accepted: boolean;
  result: string;
  error?: string;
  /** A retained worker can continue safely with this recovery turn. */
  recoveryPrompt?: string;
  delivered: boolean;
  /** Workspace selection is independent from task/dependency identity. */
  workspacePolicy?: WorkspacePolicy;
  /** A retry reuses its worker checkout so partial work is never orphaned. */
  workspace?: OrchestrationWorkspace;
  /** Only this dispatch may settle the task. A retry always gets a new id. */
  activeDispatchId?: string;
  lastDispatchId?: string;
  acceptedDispatchId?: string;
  /** Plain note while a full worktree pool keeps this task queued. */
  poolNote?: string;
  /** Epoch ms. A finite future value must not start this task again yet. */
  poolRetryAt?: number;
  /** WP-91: the plain `build` role, or the run's one `verify` task. */
  role?: "build" | "verify";
  /** WP-91: a step that cannot be undone, so the person approves it before it starts. */
  irreversible?: boolean;
  irreversibleReason?: string;
  /** The WP-14 decision's stable key, and whether the person has answered it. */
  irreversibleKey?: string;
  irreversibleAnswered?: boolean;
  /** The failed task this one repairs, and which cycle it is (2 is the re-plan). */
  repairs?: string;
  cycle?: number;
  /** WP-91: a node added by an extend round, and the node whose check found the missing work. */
  extendFrom?: string;
  /** WP-91: the worker's handoff file, recorded when the lead accepts the task. */
  handoff?: TaskHandoff;
  /** WP-40's word on the task's own gates, when a gate ran them: `passed`, `failed`, `notRun` or `held`. Absent means
   * no gate ran, which is never a pass: the run's report names those tasks rather than counting them as gated. */
  gateOutcome?: "passed" | "failed" | "notRun" | "held";
};

export type OrchestrationRun = {
  /** Version 1 remains readable; every committed snapshot is migrated to 2. */
  version: 1 | 2;
  leadId: string;
  /** Legacy project identity. Use workspace.checkoutCwd for filesystem work. */
  cwd: string;
  workspace?: OrchestrationWorkspace;
  canonicalRoot?: string;
  status: "active" | "paused" | "stopped" | "finished";
  allowedHarnesses: HarnessId[];
  allowedModels?: OrchestrationChoice[];
  proposalId?: string;
  maxWorkers: number;
  cli: string;
  tasks: OrchestrationTask[];
  dispatches?: OrchestrationDispatch[];
  error?: string;
  continuations: number;
  lastPauseReason?: string;
  requests: Record<string, { signature: string; result: unknown }>;
  /** WP-91: the one line the run is for, and the finish line that proves it. */
  goal?: string;
  check?: GoalCheck;
  /** The check's run on the untouched base, before any worker started. */
  baseline?: GoalCheckRun;
  /** Every run of the check the app itself made, newest last. A command is run once per layer (WP-81). */
  checkRuns?: GoalCheckRun[];
  /** The rules' answer about this run, refreshed whenever the record changes. */
  goalReport?: GoalNodeReport;
  /** Repair cycles taken per failed root; each entry is one cycle's task ids. */
  repairCycles?: Record<string, string[][]>;
  /** Extend rounds taken, for a re-plan that adds nodes. */
  extends?: number;
  /** WP-148: usage the children had recorded when this run finished. Absent unless the run is finished, and absent
   * when no child recorded a count. Never a row of zeros. */
  closingUsage?: ClosingUsage;
};

export function workspaceIdentity(
  projectCwd: string,
  checkoutCwd: string,
  branch?: string,
): OrchestrationWorkspace {
  return {
    id: `checkout:${pathKey(checkoutCwd)}`,
    projectCwd,
    checkoutCwd,
    kind: pathKey(projectCwd) === pathKey(checkoutCwd) ? "main" : "worktree",
    ...(branch ? { branch } : {}),
  };
}

export function orchestrationWorkspace(
  run: OrchestrationRun,
): OrchestrationWorkspace {
  return run.workspace ?? workspaceIdentity(run.cwd, run.cwd);
}

export const orchestrationProjectCwd = (run: OrchestrationRun) =>
  orchestrationWorkspace(run).projectCwd;

export const orchestrationCheckoutCwd = (run: OrchestrationRun) =>
  orchestrationWorkspace(run).checkoutCwd;

export function normalizeOrchestrationRun(
  run: OrchestrationRun,
): OrchestrationRun {
  const workspace = orchestrationWorkspace(run);
  // Older builds implemented every worker scope violation as a global pause
  // and copied the pause reason onto every running task as a generic failure.
  // Preserve the actual offender for review, but recover the collateral tasks
  // as resumable interruptions. The exact shared error is the durable marker
  // that distinguishes these tasks from ordinary worker failures.
  const legacyPauseError = run.status === "paused" ? run.error : undefined;
  const escaped =
    legacyPauseError &&
    run.tasks.find((task) =>
      legacyPauseError.startsWith(
        `${task.title} reported a write outside its assignment:`,
      ),
    )?.id;
  const tasks = run.tasks.map((task) => {
    const legacyInterrupted =
      !!legacyPauseError &&
      task.status === "failed" &&
      task.error === legacyPauseError;
    return {
      ...task,
      // WP-91: a saved task read back from the database is untrusted (a partial write, an older build, a second
      // window). A field the graph or the pump reads is kept only when it has the shape it is read as.
      files: stringList(task.files),
      scopes: stringList(task.scopes),
      dependsOn: stringList(task.dependsOn),
      handoff: savedHandoff(task.handoff),
      role:
        task.role === "build" || task.role === "verify" ? task.role : undefined,
      gateOutcome:
        task.gateOutcome === "passed" ||
        task.gateOutcome === "failed" ||
        task.gateOutcome === "notRun" ||
        task.gateOutcome === "held"
          ? task.gateOutcome
          : undefined,
      repairs:
        typeof task.repairs === "string" && task.repairs.trim()
          ? task.repairs
          : undefined,
      cycle:
        typeof task.cycle === "number" && Number.isInteger(task.cycle)
          ? task.cycle
          : undefined,
      extendFrom:
        typeof task.extendFrom === "string" && task.extendFrom.trim()
          ? task.extendFrom
          : undefined,
      ...(legacyInterrupted
        ? {
            status:
              task.id === escaped
                ? ("blocked" as const)
                : ("interrupted" as const),
            delivered: task.id === escaped ? false : true,
          }
        : {}),
      // Version 1 predates per-worker worktrees and must retain its original
      // shared-checkout behavior. New version 2 tasks default to isolation.
      workspacePolicy:
        task.workspacePolicy ??
        (run.version === 1 ? "shared" : "isolated-child"),
    };
  });
  const statusByDispatch = new Map(
    tasks.flatMap((task) =>
      task.lastDispatchId &&
      (task.status === "blocked" || task.status === "interrupted")
        ? [[task.lastDispatchId, task.status] as const]
        : [],
    ),
  );
  return {
    ...run,
    version: 2,
    cwd: workspace.projectCwd,
    workspace,
    tasks,
    dispatches: (run.dispatches ?? []).map((dispatch) => ({
      ...dispatch,
      state: statusByDispatch.get(dispatch.id) ?? dispatch.state,
    })),
    // WP-91: the goal, the finish line and the graph's answer are read back as shapes the card can draw. A
    // truncated row (a partial write, an older build) loses only the part that is malformed, never the run.
    goal: typeof run.goal === "string" ? run.goal : undefined,
    check: normalizeGoalCheck(run.check),
    baseline: normalizeCheckRun(run.baseline),
    checkRuns: Array.isArray(run.checkRuns)
      ? run.checkRuns.flatMap((entry) => {
          const check = normalizeCheckRun(entry);
          return check ? [check] : [];
        })
      : undefined,
    goalReport: normalizeGoalReport(run.goalReport),
    repairCycles: savedRepairCycles(run.repairCycles),
    ...(typeof run.extends === "number" &&
    Number.isInteger(run.extends) &&
    run.extends >= 0
      ? { extends: run.extends }
      : { extends: undefined }),
    closingUsage:
      run.status === "finished" ? normalizeClosingUsage(run.closingUsage) : undefined,
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function savedHandoff(value: unknown): TaskHandoff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  if (
    typeof input.path !== "string" ||
    typeof input.sha256 !== "string" ||
    typeof input.bytes !== "number"
  )
    return undefined;
  return {
    path: input.path,
    sha256: input.sha256,
    bytes: input.bytes,
    read: input.read === true,
    at: typeof input.at === "number" ? input.at : 0,
  };
}

/** Each root's cycles: an entry per repair cycle, each a list of task ids. Anything else is dropped. */
function savedRepairCycles(
  value: unknown,
): Record<string, string[][]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([root, cycles]) =>
      Array.isArray(cycles)
        ? [
            [
              root,
              cycles
                .map((cycle) => stringList(cycle))
                .filter((cycle) => cycle.length > 0),
            ] as const,
          ]
        : [],
    ),
  );
}
