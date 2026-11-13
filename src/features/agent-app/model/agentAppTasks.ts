// The delegate tool's app side (docs/PHASE-2-DESIGN.md, H3): the `tasks.*` app actions, over the delegation rows that
// H2 stores (src-tauri/src/delegations.rs, monos/model/delegations.ts). The `monocode` MCP server (src-tauri/src/
// mcp_server.rs) maps delegate_task / task_status / task_wait / task_cancel / task_cannot / task_answer / task_accept onto these; `monocode app
// tasks.*` reaches them too.
//
// - Only the chats Ash talks to have tasks: a Mono's own chat and a chat in a project's coding team (hub/model/
//   codingTeam.ts). Not a habit run, a worker, another plain chat or the checker (it only reads).
// - Sub-chats only ever live in a team (hub/model/monoTeams.ts; Ash, 20 Oct): a project's Lead and a coding-team chat
//   start workers in their project, while any other Mono hands a project's work to that project's coding team (a brief
//   to its Lead, `lead`) and starts workers only for work of its own, in its own team's folder.
// - A chat sees and moves only its own rows. control.rs ties the app token to the chat it was made for and the store
//   answers by owner, so a model that knows another chat's task id still gets "no task of yours".
// - Calls work only inside the caller's active turn (control.rs), and each one answers within control.rs's 35 s:
//   tasks.wait blocks for at most 25 s, and the MCP server strings waits together.
// - tasks.delegate is sessions.start with a brief: the same child id (`app-<caller>-<request>`, so the worker's chat
//   shows nested under the Mono), the same monitored launch, and a row recorded with the job's title, Ash's ask ids,
//   the goal and the hub project id.
// - A finished result read through tasks.status counts as received: the row is acknowledged and its report turn
//   dropped.
import { monoHomeFence } from "../../hub/model/hubMcp";
import { isCaptainMono } from "../../chief/model/charter";
import { readCrewRules } from "../../monos/model/crewRules";
import type { QuickLaunch } from "../../quick-composer/model/quickComposer";
import { modelEffortLabel, modelsFor, preferredModelId, resolveModel } from "../../sessions/model/models";
import { isCustomModelId } from "../../sessions/model/customModels";
import {
  HARNESSES,
  type HarnessId,
  type Session,
} from "../../sessions/model/session";
import type {
  UserQuestionPrompt,
  UserQuestionReply,
} from "../../sessions/model/userQuestion";
import {
  failedReason,
  isProviderErrorClass,
} from "../../../integrations/harness/core/providerFailure";
import {
  isOpenDelegation,
  type Delegation,
  type DelegationState,
} from "../../monos/model/delegations";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import { formatMeasuredUsd, sanitizeSpendLimit, type SpendLimit } from "../../usage/model/spend";
import { addSpendRedoLink, clearSpendLimit, NO_SPEND_LIMIT_TO_CLEAR, saveSpendLimit, spendFor, spendSnapshot } from "../../usage/model/spendGate";
import { SELF_REVIEW_SHAPE, storedReview } from "../../monos/model/workerReview";
import { waitingOnAshLine } from "../../hub/model/chatQuestions";
import { answeredJobRefusal } from "../../monos/model/ashAnswersWorker";
import { workerMemoryBlock } from "../../hub/model/hubMemoryPrimer";
import { readingEntries } from "../../fresh-eyes/model/review";
import { areasNamed, filesNamed } from "../../monos/model/workerPool";
import { isHarnessAvailable } from "../../../integrations/harness/core/availability";
import { sanitizeRule, type CrewRule } from "../../crew/model/rules";
import { benchCliRefusal } from "../../crew/model/benchCli";
import { cliFallbackLine } from "../../crew/model/cliFallback";
import { launchCatalog } from "../../crew/model/launchCatalog";
import { lineRulesFor } from "../../crew/model/lineRules";
import type { Catalog, RouteDefaults } from "../../crew/model/resolve";
import {
  applyCrewLaunch,
  callerOverride,
  crewLabels,
  crewPaths,
  crewRefusal,
  type CrewRouteAnswer,
} from "../../crew/model/taskRoute";
import { routeReason } from "../../crew/model/pick";
import { CLI_ORDER, cliLabel, isCli } from "../../crew/model/clis";
import { crewReadRefusal, projectDefaultForFolder } from "../../crew/model/host";
import { routeDefaults } from "../../crew/model/workerDefault";
import { isFanoutAgainDecisionKey } from "../../hub/model/decisionKey";
import {
  activityNoteSummary,
  crewRuleSentence,
  describeInForce,
  planWorkerChoice,
  ranFromPhrase,
  scopeClearLine,
} from "../../crew/model/workerChoice";
import { commitRoster, findMono } from "../../monos/model/mono";
import type { AgentAppHost } from "./agentApp";
import {
  limitsLine,
  setProjectWorkerModel,
  setSystemWorkerDefault,
  type Admission,
  type AdmitInput,
  type QueuedWorker,
  type WorkerLimits,
} from "../../monos/model/workerPool";
import { pathKey, projectName } from "../../../shared/lib/paths";
import { forUser } from "../../hub/model/userName";
import { judgeTask, routeWorker, type WorkerModel, type WorkerRoute } from "./taskDifficulty";
import { phaseBeforeCrew, phaseHint } from "../../phases/model/gate";
import { bindPhaseLauncher, unbindPhaseLauncher } from "../../phases/model/phaseCrew";
import { bindCrew, commentId } from "../../phases/model/store";
import { claudeRunsOnSubscriptionBridge } from "../../../integrations/harness/providers/claude/claudeDeepseekBridge";
import { checkBrief, renderBrief, type BriefIsolation } from "../../firstmate/model/brief";
// SC-4: a brief's own check lines, do-not-touch list and commit stamp (firstmate/model/briefChecks.ts).
import {
  checksRefusal,
  isCodeBrief,
  leaveList,
  splitChecks,
  validStamp,
  type CheckLine,
} from "../../firstmate/model/briefChecks";
import type { TestingMode } from "../../delivery/model/testingMode";
import { parseFanout } from "../../firstmate/model/fanoutContract";
import {
  createCheckpoint,
  describeResume,
  isComplete,
  noteQueued,
  noteRefused,
  noteStarted,
  noteStarting,
  noteStopped,
  noteWaveDone,
  planResume,
  type FanoutCheckpoint,
  type ResumePlan,
  type RowLookup,
} from "../../firstmate/model/fanoutCheckpoint";
import { windowHolder, type FanoutCheckpointStore } from "../../firstmate/host/fanoutCheckpointStore";
import { boundRequest, readOriginalRequest } from "../../firstmate/model/originalRequest";
import { fanoutSection, parseFanoutLink, planFanout, restartRequestId, taskRequestId } from "../../firstmate/model/fanoutWaves";
import { classifyBriefTask } from "../../firstmate/model/briefSkills";
import { gateRequest, type GateRequest } from "../../firstmate/model/completionGates";
import { isFirstMate } from "../../firstmate/model/checkoutGuard";
import { briefOnRemoteHost } from "../../firstmate/host/remoteDelegate";
import { remoteProjectFor } from "../../connections/model/remoteProjects";
import { WORKER_REPORT_SHAPE } from "../../firstmate/model/report";
import { askPerson, askPersonRecorded, taskMessage, type FirstMateTasksHost } from "../../firstmate/model/steering";
import { sha256Hex } from "../../historyImport/model/hash";
import { taskProjectOf } from "../../tasks/model/agentTasks";
import {
  bridgeFamily,
  isClaudeAliasModel,
  WORKER_BRIDGE_MODEL_ID,
} from "../../sessions/model/deepseekBridge";

/**
 * How many workers a project runs at once (board H8, monos/model/workerPool.ts). The app builds it on the delegation
 * rows, E5's accounts and the saved queue; absent, every worker starts at once, as before.
 */
export type WorkerPoolHost = {
  /** Every row still running or asking, from every chat (a project's count and the ports in use). */
  openRows(): Delegation[];
  /** Start this worker now, or let it wait and say why. One the app is starting from the queue always starts. */
  admit(job: AdmitInput): Admission;
  /** WP-161: read the machine (load, memory, disk) so the next `admit` sees a fresh sample. Never throws. */
  refreshHealth?(): Promise<void>;
  /** It waits: kept in order with what starts it later (and its card shows in the chat that asked). */
  enqueue(job: QueuedWorker, launch: QuickLaunch): void;
  /** It started: out of the queue, counted as heavy if it is, and holding the files it changes (r87). */
  started(job: { id: string; heavy: boolean; files?: readonly string[] }): void;
  /** The chat's waiting workers, with why each waits now. */
  queued(owner: string): { job: QueuedWorker; line: string }[];
  /** The chat took back one of its waiting workers (task_cancel). */
  unqueue(owner: string, id: string): boolean;
  limits(project: string): WorkerLimits;
  setLimits(project: string, next: Partial<WorkerLimits>): WorkerLimits;
  /** WP-171: this host can hold a task of a fan-out until the tasks that provide what it requires are delivered. */
  waitsOnProviders?: boolean;
  /** The project's own worker model (E7), when Ash chose one; else undefined for the usual Sonnet. */
  model(project: string): WorkerModel | undefined;
  /** WP-89: the project's worker default, CLI included. Absent on a host that only knows the Claude ladder. */
  projectDefault?(project: string): { cli?: string; model?: string; effort?: string } | undefined;
  /** WP-89: the worker default for every project. */
  systemDefault?(): { cli?: string; model?: string; effort?: string } | undefined;
};

/** The FIELDS entries of the task actions (agentApp.ts). */
export const TASK_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "tasks.delegate",
    [
      "intent",
      "brief",
      "title",
      "asks",
      "goal",
      "project",
      "model",
      "effort",
      "isolation",
      "heavy",
      "hard",
      "scope",
      "lead",
      "whenBusy",
      "redoes",
      "files",
      "gates",
      "checks",
      "code",
      // SC-4: paths the worker must not change. (`checks` takes the brief's own lines too.)
      "leave",
      // WP-92: the keys a worker's environment holds (at most 3).
      "secrets",
      // WP-144: a short reading list the fresh-eyes reviewers see with the plan.
      "reading",
      // WP-141: builder, reviewer or researcher. A saved role row picks the CLI.
      "role",
      // WP-70: the shared task this work moves. Not a worker's task id.
      "taskId",
      // SC-7: `fix` when the brief fixes a bug; the worker must show a failing run of its test first.
      "kind",
    ],
  ],
  // WP-141: the crew's pick for a job (a CLI or a Mono) and why. Reads only; delegate_task starts the work.
  ["tasks.pick", ["role", "title", "brief", "files", "model", "effort", "lead"]],
  // WP-171: one call for a multi-part ask whose tasks name what they own, provide, require and check.
  ["tasks.fanout", ["intent", "tasks", "resume", "confirm"]],
  ["tasks.accept", ["taskId", "accept", "reason"]],
  [
    "tasks.workers",
    [
      "project",
      "workers",
      "heavy",
      "scope",
      "cli",
      "model",
      "effort",
      "clear",
      // WP-176: a measured-cost limit. scope project or system, never mono.
      "amountUsd",
      "period",
      "warnAt",
      "spendClear",
    ],
  ],
  ["tasks.status", ["taskIds"]],
  ["tasks.wait", ["taskIds", "timeoutSeconds"]],
  ["tasks.cancel", ["taskId", "reason"]],
  ["tasks.cannot", ["taskId", "reason"]],
  ["tasks.answer", ["taskId", "requestId", "answers", "skip"]],
  // Hivra WP-14 (firstmate/model/steering.ts).
  ["tasks.message", ["taskId", "text", "whenBusy"]],
  ["tasks.ask", ["key", "question", "options", "recommended", "taskIds", "answer", "keys", "force", "reason"]],
];

/**
 * Fields only the app puts on a tasks.delegate replay: the queue, a fresh-eyes start, a retry.
 * An agent's call cannot carry the mark, so it cannot set these. delegate_tasks writes them itself
 * and calls delegate() directly, which does not go through the field list.
 */
// SC-4: `briefStamp` (the commit the brief was written against, carried with a queued or reviewed call) is the app's too: a
// caller can't choose its own stamp.
export const APP_DELEGATE_FIELDS = ["fanout", "originalRequest", "originalRequestChars", "briefStamp"] as const;

/** Set on a tasks.delegate input by the app itself. Not enumerable, so a copy or JSON drops it. */
export const appDelegateMark: unique symbol = Symbol("hivra.appDelegate");

export function markAppDelegate(input: Record<string, unknown>): Record<string, unknown> {
  Object.defineProperty(input, appDelegateMark, { value: true });
  return input;
}

export function isAppDelegate(input: object): boolean {
  return Reflect.get(input, appDelegateMark) === true;
}

/** What a delegation's row records beyond a plain monitored launch. */
export type DelegationMeta = {
  title: string;
  askIds: string[];
  /** WP-176 round 5: the owner's row this one redoes (its id, and its chat, which the spend gate follows). */
  redoes?: { id: string; childSession: string };
  goal?: string;
  /** The hub project id (what Ash OS resolves), when the folder is one of the hub's projects. */
  project?: string;
  /** WP-70: the shared task this work moves. */
  taskId?: string;
  /** WP-141: why the crew picked this CLI, one plain line kept on the row and shown on the Crew tab. */
  pickReason?: string;
};

/** WP-141: what tasks.pick asks the crew (the crew_route fields, plus the roster and how deep this chat is). */
export type CrewPickQuery = {
  labels: string[];
  paths: string[];
  override?: { cli?: string; model?: string; effort?: string };
  project?: string;
  mono?: string;
  monoRules?: CrewRule[];
  defaults?: RouteDefaults;
  catalog?: Catalog;
  monos: { id: string; name?: string; role?: string }[];
  leadMonoId?: string;
  depth: number;
  atCap: string[];
  monoOverride?: string;
};

export type CrewPickAnswer = {
  ok: boolean;
  cli: string | null;
  monoId: string | null;
  model: string | null;
  effort: string | null;
  reason: string;
};

/**
 * Why a delegation's start is refused, when it is a redo whose link was not recorded (round 5). A redo that is not
 * recorded with its parent must not run: its first turn would be judged without the parent's spend. Null when it may start.
 */
export function redoLinkRefusal(delegation: DelegationMeta | undefined, recorded: unknown): string | null {
  return delegation?.redoes && !recorded ? "The redo could not be recorded, so this run is not started." : null;
}

/** A worker chat as this window has it. */
export type TaskChild = Pick<Session, "busy" | "pendingQuestion"> & {
  /** When it last did something (now, while it works); the row's own time otherwise. */
  lastActiveAt?: number;
};

/** The app's side of the task tools (App.tsx builds it on the delegation tracker). */
export type AgentAppTasksHost = {
  /** WP-172: where a fan-out keeps its checkpoint while it sends (absent: a plan is not checkpointed). */
  fanoutCheckpoints?: FanoutCheckpointStore;
  /** The caller's own rows: by id or request, or (neither) the ones still running or owed, newest first. */
  owned(
    owner: string,
    query: { ids?: string[]; requestIds?: string[] },
  ): Promise<Delegation[]>;
  /** Every row of a task's tree (for the counts of what it delegated in turn). */
  tree?(id: string): Promise<Delegation[]>;
  /**
   * Every row still running or owed, anyone's (delegations listOpen): task_status with no ids shows the team's other
   * open jobs, so a seat that asks "is anyone on it?" sees the job CoS handed a Lead instead of only its own (none).
   */
  teamOpen?(): Promise<Delegation[]>;
  /** The owner read these finished results in its turn: they are acknowledged and their report turns dropped. */
  acknowledge(owner: string, rows: Delegation[]): Promise<void>;
  /** Resolves on the next change to any row, or after `ms`. */
  nextChange(ms: number): Promise<void>;
  /** The caller retried or split its task `row` with the new task `task` (delegate_task `redoes`): noted on the row. */
  redo?(owner: string, row: Delegation, task: string): Promise<void>;
  /** Stop a task and everything beneath it (H4's stopTree), cancelling what is still owed. */
  cancel(
    owner: string,
    row: Delegation,
    reason: string,
  ): Promise<{ stopFailed: string[]; stopped?: string[]; cancelled?: string[] }>;
  /** The chat started (true) or finished (false) a tasks.wait call: its workers' questions come back through the wait. */
  waiting?(owner: string, on: boolean): void;
  /**
   * Hivra WP-40: keep this task's gates (firstmate_gates_plan). A store error is the caller's to retry; it must not
   * look like the worker failed to start.
   */
  saveGates?(id: string, request: GateRequest, folder?: string): Promise<unknown>;
  /**
   * SC-4: how hard this project's tasks are tested (delivery_settings_get). Asked only when a code brief carries no check
   * line. Absent or undefined: the app couldn't say, and the brief is not refused for it.
   */
  testingMode?(project: string): Promise<TestingMode | undefined>;
  /** SC-4: the HEAD of the project's main checkout, to stamp a brief with (firstmate_brief_stamp). Undefined: none. */
  briefStamp?(folder: string): Promise<string | undefined>;
  /**
   * SC-4: keep a started task's check lines, stamp and do-not-touch list on its row (firstmate_brief_keep). The first keep
   * wins, so a retry changes nothing. A miss is not a failed start: the same call again saves them.
   */
  keepBrief?(id: string, brief: KeptBrief): Promise<unknown>;
  /** Hivra WP-40: the first mate accepts or refuses an unsure verdict (firstmate_gates_decide). */
  decideGates?(owner: string, id: string, accept: boolean, reason?: string): Promise<unknown>;
  /** The running task working in this chat itself, newest first: what `tasks.cannot` with no taskId declares on. */
  selfTask?(sessionId: string): Promise<Delegation | undefined>;
  /**
   * Hivra WP-10: how deep a delegation from this chat would sit; rejects past the cap (first mate, first mate, workers)
   * with the reason (src-tauri/src/firstmate/mod.rs check_depth).
   */
  checkDepth?(ownerSession: string, opts?: { fanout?: boolean }): Promise<number>;
  /** Hivra WP-14: steering messages and decisions (firstmate/model/steering.ts). */
  firstMate?: FirstMateTasksHost;
  /**
   * The agent says it cannot finish this task, with its plain reason (the declared `blocked` stall, delegations.rs). It
   * is Ash's at once; it stands until the row moves. False: the row moved before it could be recorded.
   */
  cannot?(by: string, row: Delegation, reason: string): Promise<boolean>;
  /** Answer the worker's open question (and log it on the row). */
  answer?(
    owner: string,
    row: Delegation,
    requestId: number,
    reply: UserQuestionReply,
  ): Promise<void>;
  child?(sessionId: string): TaskChild | undefined;
  /** The hub project id of a folder, and the folder of a hub project id. */
  hubProjectId?(folder: string): string | undefined;
  hubProjectFolder?(id: string): string | undefined;
  /** WP-141 round 11: every hub project folder, so a worktree can find the project that owns it. */
  hubProjectRoots?(): readonly string[];
  /** The clock waits are measured on; tests pin it. */
  now?(): number;
  /** Workers per project, and the ones waiting for a free worker (H8). */
  pool?: WorkerPoolHost;
  /**
   * The memory a worker of this chat starts with, in its brief: the chat's project's current memory and Ash's global one
   * (hub/model/hubMemoryPrimer.ts workerMemoryBlock, the default), or undefined for a chat with no project.
   */
  memoryBrief?(ownerSession: string, harness: HarnessId): Promise<string | undefined>;
  /**
   * WP-156: active standing answers for the project a Lead is briefed on. Empty, or a failure, leaves the brief as it
   * was. The text is guidance, not permission.
   */
  standingBrief?(project: string): Promise<string | undefined>;
  /**
   * WP-13: which CLI, model and effort this task uses. Absent, or a failure, keeps the model already chosen.
   * Labels are areas such as `ui`, not `area:ui`.
   */
  crewRoute?(query: {
    labels: string[];
    paths: string[];
    override?: { cli?: string; model?: string; effort?: string };
    project?: string;
    mono?: string;
    /** WP-89: the Mono, project and system defaults, and the catalog that judges them. */
    defaults?: RouteDefaults;
    catalog?: Catalog;
  }): Promise<{
    cli?: string | null;
    model?: string | null;
    effort?: string | null;
    cliFrom?: string | null;
    modelFrom?: string | null;
    effortFrom?: string | null;
    /** WP-141: the matched rule's first label, and what was skipped (Never use, the lock), for the reason. */
    ruleLabel?: string | null;
    skipped?: { field?: string | null; from?: string | null; value?: string | null; reason?: string | null }[] | null;
    /** WP-141: the Never use list and the lock the route was chosen under. */
    never?: string[] | null;
    lock?: boolean | null;
  } | null | undefined>;
  /**
   * WP-141: the one gate a worker or session launch passes before its process starts (crew_launch_check). It rejects
   * with the reason when the CLI is on Never use, is not the locked default under the lock, or the policy can't be read.
   */
  crewGate?(input: {
    cli: string;
    folder?: string;
    mono?: string;
    lockedDefault?: string;
    sessionId: string;
    /** The session that started this one, so the child keeps that session's projects. */
    parentSession?: string;
  }): Promise<void>;
  /** WP-141 HIGH-B: whether any saved crew policy, in any scope, has the lock on. */
  crewAnyLock?(): Promise<boolean>;
  /**
   * WP-141: the crew's pick across signed-in CLIs and the Monos this chat may brief, from the person's rules, defaults,
   * Always use my default, Never use and fallback order (`crew_pick`). Reads only.
   */
  crewPick?(query: CrewPickQuery): Promise<CrewPickAnswer>;
  /** WP-141: the Monos (project Leads) this Mono may brief: `lead` is what delegate_task's `lead` takes. */
  pickMonos?(monoId: string): { id: string; name?: string; role?: string; lead: string }[];
  /**
   * WP-144: fresh-eyes review before builders start. Absent means today's start.
   * Hold only when `hold` is true.
   */
  freshEyes?(input: {
    project: string;
    requestId: string;
    plan: string;
    ownerSession: string;
    reading?: unknown;
    /** The delegate call, kept so a later approval can start this same brief. */
    held?: Record<string, unknown>;
  }): Promise<{ hold: boolean; why: string }>;
  /** The Lead a brief names exists and this Mono may brief it. Throws when it does not. Checked before a review. */
  checkLead?(source: Session, mono: { id: string; name?: string }, lead: string): void | Promise<void>;
  /** WP-141: the lock and Never use list in force for a Mono in a folder. Read before a brief or a default change. */
  crewPolicy?(monoId: string | undefined, folder: string | undefined): Promise<{ neverUse: string[]; lock: boolean }>;
  /** WP-156: the project the named Lead keeps, so the brief carries that project's standing answers. */
  leadProject?(
    source: Session,
    mono: { id: string; name?: string },
    lead: string,
  ): string | undefined | Promise<string | undefined>;
  /** WP-144: the chat's briefs waiting on a fresh-eyes review, each named by the chat it will be. */
  freshEyesWaiting?(ownerSession: string): Promise<{ childSessionId: string; title: string; line: string }[]>;
  /** WP-144: the chat took back a brief waiting on a review (task_cancel). True when one matched. */
  freshEyesCancel?(ownerSession: string, childSessionId: string): Promise<boolean>;
  /**
   * Where a Mono's work goes (hub/model/monoTeams.ts). Absent outside the hub, where a Mono starts workers in its
   * projects as before.
   */
  monoWork?: {
    /** A project's Lead: its workers are its coding team's, in its project's folder. */
    isLead(monoId: string): boolean;
    /** The coding team a project the Mono named is (it has a Lead): its work goes there as a brief to that Lead. */
    codingTeam(named: string): { projectId: string; leadName: string; name: string } | undefined;
    /** The Mono's own team, made the first time it hands out work of its own: its folder and name. */
    ownTeam(mono: { id: string; name?: string }): Promise<{ folder: string; name: string }>;
  };
  /**
   * A Mono briefs a project's Lead in its own long-running chat instead of starting a worker (double delegation,
   * hub/model/leadershipDelegation.ts). `lead` is what the Mono named; the host finds it among the Leads this Mono may
   * brief, records the row (owner: this chat, child: the Lead's chat) and sends the brief in.
   */
  briefLead?(
    owner: Session,
    mono: { id: string; name?: string },
    input: {
      lead: string;
      requestId: string;
      brief: string;
      title: string;
      goal?: string;
      askIds: string[];
      mode: "queue" | "steer";
      /** WP-70: the shared task this brief moves. */
      taskId?: string;
    },
  ): Promise<{
    row: Delegation | null;
    childSessionId: string;
    delivery: "started" | "queued" | "steered";
    leadName: string;
  }>;
};

/** What agentApp.ts lends the task actions (its own launch rules, so a delegation starts exactly like sessions.start). */
export type TaskHelpers = {
  startLaunch(
    source: Session,
    input: Record<string, unknown>,
    host: AgentAppHost,
  ): QuickLaunch;
  /** Files a started session into the Mono's sidebar folder, as sessions.start does. */
  fileStarted(source: Session, launch: QuickLaunch, id: string, host: AgentAppHost): void;
};

/** A delegated worker's permission mode (H4): full access, so no approval prompt strands it. */
export const WORKER_RUNTIME_MODE = "full-access";

const BRIEF_MAX = 60_000;
const ASKS_MAX = 50;
const IDS_MAX = 20;
const WAIT_MAX_SECONDS = 25;
/** How often a wait looks again even without a change event (one can slip between a read and the listener). */
const WAIT_POLL_MS = 2_000;

/** The ports workers are given, one each (workerPort), away from the usual dev ports. */
export const WORKER_PORT_BASE = 41_000;
export const WORKER_PORT_SPAN = 2_000;

/**
 * A worker's own port: from its chat id, so it is the same every time, moved on past any port a running sibling holds.
 * Baseline, 20 Oct: two workers on the test project shared port 4317 and one stopped the other's dev server.
 */
export function workerPort(childSession: string, taken: ReadonlySet<number> = new Set()): number {
  let hash = 0;
  for (const char of childSession) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  for (let step = 0; step < WORKER_PORT_SPAN; step++) {
    const port = WORKER_PORT_BASE + ((hash + step) % WORKER_PORT_SPAN);
    if (!taken.has(port)) return port;
  }
  return WORKER_PORT_BASE + (hash % WORKER_PORT_SPAN);
}

/** The port a brief gave its worker (workerRules), if any. */
export function portOfBrief(brief: string | null | undefined): number | undefined {
  // The person's quoted request (WP-171) may talk about ports of its own; only the app's own lines name this worker's.
  const own = (brief ?? "").replace(/^## Original request\n[\s\S]*?(?=^## |(?![\s\S]))/m, "");
  const found = /\bPORT=(\d{4,5})\b/.exec(own);
  return found ? Number(found[1]) : undefined;
}

/**
 * What every worker works by, in its brief (baseline, 20 Oct: two workers shared a port and one killed the other's dev
 * server): its own port, never another's process, its own checkout, and the self-review its report has to end with
 * (A7: the app refuses a report without one, so "I checked it" is a recorded fact, not a claim). r95 (c02 BLIND 0774):
 * a worker whose brief said "Do not add the health route" found a sibling's landed route in its copy and removed it, and
 * its landing took the sibling's test out of the project; workers leave code they didn't write alone.
 */
export function workerRules(port: number): string {
  return `<worker_rules>\n- Other workers may be running in this project at the same time. Your port is ${port}: start any server you need (a dev server, an API, a preview) on it, with PORT=${port} or the tool's own port option, never on the project's default port.\n- Never stop, kill or restart a process you didn't start (no pkill, killall or kill of anyone else's server). If a port or a file is busy, use your own port, wait, or say so in your report.\n- Work in your own checkout, the folder you were started in.\n- Your checkout may already hold other workers' finished work. Never remove or rewrite code you didn't write unless your brief names it, even where your brief says not to add it: leave it, and say what looks wrong at the top of your report.\n- Never weaken a test, an allow list or a guard to get past a decision that isn't yours: stop and ask your Lead.\n- Ash may write in your chat himself. His words decide: they outrank your brief and any pick from your Lead. A choice of his your brief already carries is settled: never ask it again; if a check disagrees with it, say that mismatch in one line.\n- You have no memory of the chat that sent you. Everything you may assume is in this brief, including the person's own request quoted in it. If something your task depends on isn't there, say so in your report instead of guessing at the chat.\n- Never ask the person a question. Where your brief leaves a point open, take the most reasonable reading and say in your report what you assumed. A choice that is Ash's is not yours, as below.\n- If a tool call is refused because nobody can approve it for you (a path or command outside what your task allows), stop retrying it and say in your report exactly what was blocked and where, so your first mate can send the task again with that named.\n- Updates and reports in a few short lines: what changed, and each check as one line (\"npm test: 14 passed\"); never paste test or command output.\n- Test what your change can reach, not the whole suite: the project's own affected-tests command if it has one (npm run check:affected, nx affected, turbo run test --filter=...[origin/main]), else the runner's related mode on your changed files (vitest related, jest --findRelatedTests, cargo test -p <crate>, go test on the changed packages, pytest on the matching test files), plus the type check. Run the full suite only when your brief asks, when you changed what every test stands on (the package manifest, the lockfile, a test, build or TypeScript config, the test setup, CI files), or when the project's rules say so; your report says which you ran.\n- Run your tests with the run_checks tool instead of running the test command yourself: it runs the project's own tests for what you changed and returns the summary line, each failing test with its message, and the path of the full log, so there is nothing to paste. When you are fixing a bug, write the test that fails first and run it with run_checks before you change the code; a build error or zero tests is not a failing run. If the tool says the project declares no test command, run its tests yourself and say so in your report.\n- A choice that is Ash's (your brief says so or leaves it open, like which day a week starts) is not yours to settle in code: don't build one answer in. If your task can't go on without it, stop and ask your Lead.\n- If you find something that doesn't match (two copies of a type that disagree, a doc that says one thing while the code does another), or you built something differently from your brief or TODO, say so plainly at the top of your report.\n- End with your report in exactly this shape. Checks with their results, links, files and commits are evidence; your opinion of your own work is not:\n\n${WORKER_REPORT_SHAPE}\n- Then a self-review, in exactly this shape. A report without one is not recorded as done and comes straight back to you:\n\n${SELF_REVIEW_SHAPE}\n- ${monoHomeFence()}\n</worker_rules>`;
}

/**
 * Every brief opens with this, so nothing mistakes it for Ash's own words (the studio's sweep skips such chats). A
 * worker's own rules (`rules`: workerRules) come after the brief, then its finish line, then (for a worker of a chat on
 * a project) that project's memory and Ash's global one (`memory`), so it starts on what holds now without calling
 * ash_recall. The finish line stays the last paragraph before the memory: it is what /goal is set to (claudeGoal.ts).
 */
export function briefPrompt(owner: string, brief: string, goal?: string, memory?: string, rules?: string): string {
  return [
    `[MonoCode brief from ${owner}]`,
    brief,
    ...(rules?.trim() ? [rules.trim()] : []),
    ...(goal ? [`Done when: ${goal}`] : []),
    ...(memory?.trim() ? [memory.trim()] : []),
  ].join("\n\n");
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name} must be a non-empty string under ${max} characters`);
  return value.trim();
}

function firstLine(brief: string): string {
  return brief.split("\n").find((line) => line.trim())!.trim().slice(0, 200);
}

/** The studio's ask id rule (ashos/hub.py ASK_ID; delegations.rs ask_id_ok): one bad id would refuse the whole copy. */
function askIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > ASKS_MAX ||
    !value.every((id) => typeof id === "string" && /^a_[A-Za-z0-9]{1,40}$/.test(id.trim()))
  )
    throw new Error(
      forUser`asks must be up to ${ASKS_MAX} Ash OS ask ids (a_...), as ash_record returned them`,
    );
  return [...new Set(value.map((id: string) => id.trim()))];
}

function taskIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > IDS_MAX ||
    !value.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    throw new Error(`taskIds must list 1 to ${IDS_MAX} task ids (t-...)`);
  return [...new Set(value as string[])];
}

/** The files or areas a job covers, as the Lead declares them (delegate_task `scope`): a size signal, never prose. */
const SCOPE_MAX = 50;

/** delegate_task's `files`: up to 30 paths, each a file or folder in the project. */
function fileList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 400))
    throw new Error("files must be a list of the project's file or folder paths it will change");
  return value.slice(0, 30).map((item: string) => item.trim());
}

/** WP-92: delegate_task's `secrets`: up to 3 keys, each into one environment variable of its own, never a value. */
const SECRETS_MAX = 3;
function workerSecrets(value: unknown): { name: string; env: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SECRETS_MAX)
    throw new Error(`secrets must be up to ${SECRETS_MAX} keys, each with a name and an env`);
  const out = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(
        'Each key is an object with a name and an env, like {"name": "stripe-api-key", "env": "STRIPE_API_KEY"}',
      );
    const row = item as Record<string, unknown>;
    const extra = Object.keys(row).filter((key) => key !== "name" && key !== "env");
    if (extra.length) throw new Error(`Unknown secrets fields: ${extra.join(", ")}`);
    const name = text(row.name, "name", 64);
    const env = text(row.env, "env", 64);
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(env))
      throw new Error("env must be capital letters, digits and underscores, like STRIPE_API_KEY");
    return { name, env };
  });
  if (new Set(out.map((secret) => secret.name.toLowerCase())).size !== out.length)
    throw new Error("Each key once: two entries name the same key");
  if (new Set(out.map((secret) => secret.env)).size !== out.length)
    throw new Error("Each key needs its own env name");
  return out;
}

function scopeList(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > SCOPE_MAX ||
    !value.every((item) => typeof item === "string" && item.trim() && item.trim().length <= 200)
  )
    throw new Error(forUser`scope must be up to ${SCOPE_MAX} files or areas, each a short line`);
  return value.map((item: string) => item.trim());
}

/** The effort a start runs at, as the picker words it (the same value the model's own setting carries). */
function launchEffort(launch: Pick<QuickLaunch, "harness" | "model" | "modelSettings">): string | undefined {
  return launch.model
    ? modelEffortLabel(resolveModel(launch.harness, launch.model), launch.modelSettings)
    : undefined;
}

/**
 * What a start runs on, in the words the worker card uses ("DeepSeek V4.1 Flash · High"), so a Lead names the model and
 * effort the way Ash sees them, never the raw id (r61, PM: a Lead said "claude:deepseek-v4.1-flash", not DeepSeek high).
 */
export function launchModelName(
  launch: Pick<QuickLaunch, "harness" | "model" | "modelSettings">,
): string | undefined {
  if (!launch.model) return undefined;
  const name = resolveModel(launch.harness, launch.model).name;
  const shown = launch.harness === "claude" ? name.replace(/^Claude /, "") : name;
  const effort = launchEffort(launch);
  return effort ? `${shown} · ${effort}` : shown;
}

/** A model id from any harness, or a family ("sonnet") among the caller's own harness's models. */
function taskModel(
  value: unknown,
  source: Session,
  onBridge = false,
): { harness: HarnessId; model: string } | undefined {
  if (value === undefined) return undefined;
  const wanted = text(value, "model", 128);
  // On the DeepSeek launcher a Grok or DeepSeek name runs as DeepSeek. A Claude name
  // is only a label there: the worker takes the launcher's own route.
  if (onBridge) {
    const family = bridgeFamily(wanted.replace(/^[a-z][a-z0-9-]*:/i, ""));
    if (family === "grok" || family === "deepseek") return { harness: "claude", model: WORKER_BRIDGE_MODEL_ID };
    if (family === "claude") return undefined;
  }
  // One of Ash's own models ("Other models"): it runs through Claude Code's router, as the picker starts it.
  if (isCustomModelId(wanted)) return { harness: "claude", model: wanted };
  for (const harness of HARNESSES) {
    const exact = modelsFor(harness).find((model) => model.id === wanted);
    if (exact) return { harness, model: exact.id };
  }
  const family = wanted.toLowerCase();
  const own = modelsFor(source.harness);
  const bare = (id: string) => id.slice(id.indexOf(":") + 1).toLowerCase();
  const match =
    own.find((model) => bare(model.id) === family) ??
    own.find((model) => bare(model.id).startsWith(`${family}-`)) ??
    own.find((model) => model.name.toLowerCase() === family);
  if (match) return { harness: source.harness, model: match.id };
  throw new Error(
    `Unknown model "${wanted}". Use a model id or family, such as: ${own
      .slice(0, 6)
      .map((model) => model.id)
      .join(", ")}`,
  );
}

/**
 * Where a redo of `row` works: the checkout its worker had (still on disk, in the same project), or `{}` for a fresh
 * one. The app's own session row says where that worker ran; a worker in the shared checkout leaves `{}` too.
 */
async function redoCheckout(row: Delegation, host: AgentAppHost, cwd: string): Promise<{ path?: string }> {
  const child = await host.session(row.childSession).catch(() => null);
  const tree = child?.worktreeCwd;
  if (!child || !tree || pathKey(child.cwd) !== pathKey(cwd) || pathKey(tree) === pathKey(cwd)) return {};
  const listed = await host.worktrees(cwd).catch(() => undefined);
  const live = listed?.worktrees.find((entry) => !entry.missing && pathKey(entry.path) === pathKey(tree));
  return live ? { path: live.path } : {};
}

/** The route's reason, led by why a model the Lead named isn't used: it can't run on the bridge. */
function withOffBridgeWhy(route: WorkerRoute | undefined, asked: string | undefined): WorkerRoute | undefined {
  if (!route || !asked) return route;
  return { ...route, why: `"${asked}" doesn't run on the bridge (workers run only on Grok 4.7 or DeepSeek). ${route.why}` };
}

/** Who delegates: a Mono's own chat (signed with its name), or a coding-team chat (signed "<Project> coding team"). */
type TaskOwner = {
  name: string;
  mono?: {
    id: string;
    name?: string;
    crewRules?: unknown;
    /** WP-89: this Mono's worker default, when it set one. */
    workerDefault?: { cli?: string; model?: string; effort?: string };
  };
  team?: { project: string; folder: string };
};

/** A Mono's stored crew rules, checked again before they leave this process. A broken one is dropped. */
function carriedMonoRules(rules: unknown): CrewRule[] {
  if (!Array.isArray(rules)) return [];
  const out: CrewRule[] = [];
  for (const rule of rules) {
    const clean = sanitizeRule(rule, "person");
    if (!clean) continue;
    out.push(clean);
    if (out.length >= 40) break;
  }
  return out;
}

/** Only a Mono's own chat or a coding-team chat has tasks; the checker only reads. */
/** WP-141: the folder whose crew policy a launch or a pick reads: the chat's team, else the project it names, else its own. */
/**
 * WP-141 round 11: the worker default a session, a brief and a pick send. The same lookup as a plan
 * (projectDefaultForFolder): the folder's own hub project, then the most specific project that owns it.
 * Hub roots, when the host names them, are sent so a project with no crew row is still found.
 */
function projectDefaultFor(tasks: AgentAppTasksHost, folder: string) {
  return projectDefaultForFolder(
    folder,
    (key) => tasks.pool?.projectDefault?.(tasks.hubProjectId?.(key) ?? key),
    { roots: tasks.hubProjectRoots?.() },
  );
}

function crewScopeFolder(owner: TaskOwner, source: Session, named: string | undefined, tasks: AgentAppTasksHost): string {
  if (owner.team) return owner.team.folder;
  if (named === undefined) return source.cwd;
  // WP-141 HIGH-A: a name that is not a hub project is refused, not read as a folder. Policy and launch share one folder.
  const hub = tasks.hubProjectFolder?.(named);
  if (hub) return hub;
  // A bare name the hub doesn't know (a folder's last segment, say) is refused: the policy would be read for nothing.
  if (!named.startsWith("/") && !named.startsWith("~"))
    throw new Error(`"${named}" is not one of the app's projects, so nothing was started.`);
  return named;
}

/** WP-141: a reason a fallback CLI may not take the work: the lock is on, or the chat's own CLI is on Never use. */
function fallbackRefusal(answer: CrewRouteAnswer | null | undefined, baseline: string, routed: string): string | undefined {
  const absent = `${cliLabel(routed)} isn't installed here`;
  if (answer?.lock === true) return `${absent}, and Always use my default is on, so no other CLI was used.`;
  if ((answer?.never ?? []).includes(baseline))
    return `${absent}, and ${cliLabel(baseline)} is on Never use, so no other CLI was used.`;
  return undefined;
}

/**
 * WP-141: the one gate a launch passes before its process starts. Without a gate (a build with none) the route alone
 * decides; the app always wires one. The locked default is the route's CLI when the route is known.
 */
export async function gateCrewStart(
  tasks: Pick<AgentAppTasksHost, "crewGate"> | undefined,
  input: {
    cli: string;
    folder?: string;
    mono?: string;
    route?: CrewRouteAnswer | null;
    sessionId: string;
    parentSession?: string;
  },
): Promise<void> {
  // WP-141 round 5: a build with no gate refuses. Failing open here let a launch through without a decision.
  if (!tasks?.crewGate) throw new Error("The crew gate is unavailable, so nothing was started.");
  await tasks.crewGate({
    cli: input.cli,
    ...(input.folder ? { folder: input.folder } : {}),
    ...(input.mono ? { mono: input.mono } : {}),
    ...(input.route?.cli ? { lockedDefault: input.route.cli } : {}),
    sessionId: input.sessionId,
    ...(input.parentSession ? { parentSession: input.parentSession } : {}),
  });
}

/**
 * WP-141 MEDIUM 5: sessions.start is gated like a worker. It has no task route, so the locked default is the route's
 * pick for the Mono and folder with no task: a route that can't be read refuses the start.
 */
export async function gateSessionStart(
  host: AgentAppHost,
  source: Session,
  cli: string,
  folder: string,
  sessionId: string,
): Promise<void> {
  const tasks = host.tasks;
  if (!tasks?.crewGate) throw new Error("The crew gate is unavailable, so nothing was started.");
  const mono = host.isMono(source.id) ? host.monoOf?.(source.id) : undefined;
  let route: CrewRouteAnswer | null | undefined;
  if (tasks.crewRoute) {
    try {
      route = await tasks.crewRoute({
        labels: [],
        paths: [],
        project: folder,
        ...(mono?.id ? { mono: mono.id } : {}),
        defaults: routeDefaults({
          mono: mono?.workerDefault,
          project: await projectDefaultFor(tasks, folder),
          system: tasks.pool?.systemDefault?.(),
        }),
      });
    } catch (error) {
      throw new Error(crewReadRefusal(error, "The crew policy could not be read, so nothing was started"));
    }
  }
  await gateCrewStart(tasks, { cli, folder, mono: mono?.id, route, sessionId, parentSession: source.id });
}

function taskOwner(source: Session, host: AgentAppHost): { owner: TaskOwner; tasks: AgentAppTasksHost } {
  const mono = host.isMono(source.id) ? host.monoOf?.(source.id) : undefined;
  const team = mono ? undefined : host.codingTeamOf?.(source.id);
  if (!mono && !team)
    throw new Error(
      host.isHabitRun?.(source.id)
        ? "A habit run can't delegate. Post what you found; the Mono delegates from its own chat."
        : "Only a Mono's own chat or a chat in a project's coding team can delegate and manage tasks. A worker reports to the chat that delegated it.",
    );
  if (mono?.id === CHECKER_MONO_ID)
    throw new Error("The checker only reads. It never delegates or starts work.");
  if (!host.tasks) throw new Error("Tasks are unavailable in this build");
  const owner: TaskOwner = mono
    ? { name: mono.name || mono.id, mono }
    : { name: team!.name, team: { project: team!.project, folder: team!.folder } };
  return { owner, tasks: host.tasks };
}

/**
 * The Chief of Staff hands work on and never starts crew itself (chief/model/charter.ts). Its only road to a worker is
 * a brief to a project's Lead (captain.handoff, or tasks.delegate with `lead`); a worker of its own is refused here.
 */
/** steering.rs TEXT_MAX: a message to a worker over this is refused. */
const STEER_TEXT_MAX = 8_000;

export const CAPTAIN_NO_CREW =
  "The Chief of Staff hands work on and never starts workers itself. Use captain.handoff (or tasks.delegate with lead) so the project's first mate runs the work.";

function refuseCaptainCrew(source: Session, host: AgentAppHost, toLead: boolean): void {
  if (toLead || !host.isMono(source.id)) return;
  if (isCaptainMono(host.monoOf?.(source.id) as Parameters<typeof isCaptainMono>[0])) throw new Error(CAPTAIN_NO_CREW);
}

/** The caller's rows by id, in the order asked; one that isn't the caller's reads exactly like one that doesn't exist. */
async function ownRows(
  source: Session,
  tasks: AgentAppTasksHost,
  ids: string[],
): Promise<Delegation[]> {
  const rows = await tasks.owned(source.id, { ids });
  const missing = ids.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length)
    throw new Error(
      `No task ${missing.join(", ")} of yours. task_status without taskIds lists the ones still running or owed.`,
    );
  return ids.map((id) => rows.find((row) => row.id === id)!);
}

function iso(ms: number | null | undefined): string | undefined {
  return ms != null && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15
    ? new Date(ms).toISOString()
    : undefined;
}

function activity(row: Delegation, child: TaskChild | undefined): string {
  if (row.state === "question") return "waiting for your answer";
  if (!isOpenDelegation(row)) return "stopped";
  // Declared (task_cannot): the work itself says it cannot finish, with its reason. It is Ash's, not a silence.
  if (row.stallKind === "blocked")
    return row.stallReason ? `cannot finish: ${row.stallReason}` : "cannot finish";
  // It asked Ash itself (a Lead's own AskUserQuestion): that is why it stands still, not its work.
  if (child?.pendingQuestion) return waitingOnAshLine(child.pendingQuestion);
  return child?.busy ? "working" : "idle";
}

function lastActiveAt(row: Delegation, child: TaskChild | undefined) {
  return iso(Math.max(row.updatedAt, child?.lastActiveAt ?? 0));
}

/** What task_status says about the gates. Anything that isn't a pass is not passed. */
function gateLine(verdict: string | null | undefined): string | undefined {
  if (!verdict) return undefined;
  switch (verdict) {
    case "unsure":
      return "Its checks need you. Accept with task_accept, or refuse, either way with a reason. It is not done until you do.";
    case "failed":
      return "Its checks failed.";
    case "pending":
      return "Its checks are still running.";
    case "passed":
      return "Its checks passed.";
    default:
      return "Its checks have not passed.";
  }
}

/** A task as task_wait reports it: status only. */
function statusView(row: Delegation, child: TaskChild | undefined) {
  const gates = gateLine(row.gateVerdict);
  return {
    taskId: row.id,
    ...(row.title ? { title: row.title } : {}),
    status: row.state,
    activity: activity(row, child),
    lastActiveAt: lastActiveAt(row, child),
    hasPendingQuestion: row.state === "question",
    // WP-40: the gates' word, on the short view too, so a wait sees that a finished task is not done yet.
    ...(gates ? { gates } : {}),
    // Stuck without asking or failing (workerStall.ts): steer it with a message, or cancel it and brief again.
    ...(row.state === "running" && row.stallKind
      ? {
          stalled: {
            kind: row.stallKind,
            ...(row.stallReason ? { reason: row.stallReason } : {}),
            ...(iso(row.stalledAt) ? { since: iso(row.stalledAt) } : {}),
          },
        }
      : {}),
  };
}

function counts(rows: Delegation[]) {
  const by: Partial<Record<DelegationState | "total", number>> = {
    total: rows.length,
  };
  for (const row of rows) by[row.state] = (by[row.state] ?? 0) + 1;
  return by;
}

/** A task as task_status reports it: everything the owner needs to review it. */
function taskView(
  row: Delegation,
  child: TaskChild | undefined,
  children: Delegation[] | undefined,
) {
  const errorClass =
    row.state === "failed" && isProviderErrorClass(row.errorClass)
      ? row.errorClass
      : undefined;
  const resetsAt = iso(row.resetsAt);
  // A7: the worker's own answer about its work, beside its result, so a Lead reviewing a done task reads what was
  // checked and what is still open without going to the worker's chat for it.
  const review = storedReview(row.selfReview);
  return {
    ...statusView(row, child),
    childSessionId: row.childSession,
    ...(row.reviewRequired ? { selfReviewRequired: true } : {}),
    ...(review ? { selfReview: review } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(errorClass
      ? {
          errorClass,
          reason: failedReason(errorClass),
          ...(row.retryable != null ? { retryable: row.retryable } : {}),
          ...(resetsAt ? { resetsAt } : {}),
        }
      : {}),
    ...(row.pendingQuestion ? { pendingQuestion: row.pendingQuestion } : {}),
    ...(row.state === "question" && child?.pendingQuestion
      ? { question: questionView(child.pendingQuestion) }
      : {}),
    ...(row.askIds.length ? { asks: row.askIds } : {}),
    ...(row.goal ? { goal: row.goal } : {}),
    ...(children?.length ? { delegated: counts(children) } : {}),
  };
}

function questionView(prompt: UserQuestionPrompt) {
  return {
    requestId: prompt.requestId,
    ...(prompt.title ? { title: prompt.title } : {}),
    questions: prompt.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      multiSelect: question.multiSelect,
      options: question.options.map((option) => ({ id: option.id, label: option.label })),
    })),
  };
}

/** WP-70: the shared task a delegation moves. Absent when the chat didn't name one. */
function sharedTaskId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
    throw new Error("taskId must be the shared task's id");
  }
  return value.trim();
}

/** A named task must be in this chat's project. Checked before a worker starts, and only when the store is there. */
async function sharedTaskInThisProject(source: Session, taskId: string, host: AgentAppHost): Promise<void> {
  if (!host.taskStore) return;
  let project: string;
  try {
    project = taskProjectOf(source, host);
  } catch {
    return;
  }
  let found: unknown;
  try {
    found = await host.taskStore("tasks_get", {
      actor: { id: source.id, project, kind: "agent" },
      id: taskId,
    });
  } catch (error) {
    throw new Error(error instanceof Error && error.message ? error.message : "No task with that id.");
  }
  const projectId =
    found && typeof found === "object" && "projectId" in found ? (found as { projectId?: unknown }).projectId : undefined;
  if (projectId !== project) throw new Error("That task is in another project.");
}

async function delegate(
  source: Session,
  requestId: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  helpers: TaskHelpers,
) {
  const { owner, tasks } = taskOwner(source, host);
  refuseCaptainCrew(source, host, input.lead !== undefined);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    throw new Error(
      "request ID must use letters, digits, underscores or hyphens (up to 100)",
    );
  // Hivra WP-10: the model fills the brief's intent, spec and definition of done; a brief with any of them empty or
  // left as a placeholder is refused before anything starts (firstmate/model/brief.ts).
  const unfit = checkBrief({ intent: input.intent, spec: input.brief, done: input.goal });
  if (unfit) throw new Error(unfit);
  // SC-4: the brief's own check lines and do-not-touch list are read before anything starts; a bad one is refused in
  // plain words. A plain name in `checks` is still the id of one of the project's own checks.
  const own = splitChecks(input.checks);
  const leave = leaveList(input.leave);
  // WP-171: a task of a fan-out carries its link: the contract its brief shows, and what it waits for.
  const link = input.fanout === undefined ? undefined : parseFanoutLink(input.fanout);
  if (link && input.lead !== undefined) throw new Error("A fan-out's tasks are workers: leave out lead.");
  const contract = link ? fanoutSection(link) : undefined;
  // WP-171: every brief quotes the person's own request, cut to the quote budget at this read. A longer one is
  // trimmed, not refused, and the cut note keeps the real length. A task that waited keeps the request it was asked
  // under, not whatever the person said since.
  if (input.originalRequest !== undefined && typeof input.originalRequest !== "string")
    throw new Error("originalRequest must be the person's request, as text");
  const supplied = typeof input.originalRequest === "string" ? input.originalRequest : "";
  const knownChars =
    typeof input.originalRequestChars === "number" && Number.isFinite(input.originalRequestChars)
      ? input.originalRequestChars
      : undefined;
  const taken = supplied ? boundRequest(supplied, knownChars) : readOriginalRequest(source.blocks);
  const originalRequest = taken?.text || undefined;
  const originalRequestChars = taken && taken.chars > taken.text.length ? taken.chars : undefined;
  const extras = { contract, originalRequest, originalRequestChars };
  const intent = text(input.intent, "intent", BRIEF_MAX);
  const brief = text(input.brief, "brief", BRIEF_MAX);
  const title =
    input.title === undefined ? firstLine(brief) : text(input.title, "title", 200);
  const asks = askIds(input.asks);
  const goal = text(input.goal, "goal", 1_000);
  // WP-70: the shared task this work moves. Checked before a worker starts.
  const sharedTask = sharedTaskId(input.taskId);
  if (sharedTask) await sharedTaskInThisProject(source, sharedTask, host);
  // WP-84: a costly task finishes its phase documents before anyone writes code. A usual task does not wait.
  if (sharedTask) {
    bindPhaseLauncher(sharedTask, { source, host, helpers, requestId });
    try {
      const gate = await phaseBeforeCrew(sharedTask, phaseHint(input), source.cwd, commentId);
      if (gate.hold) {
        return {
          taskId: null,
          childSessionId: `phase-${sharedTask}`,
          status: "working",
          title,
          phased: true,
          note: gate.why,
        };
      }
    } finally {
      unbindPhaseLauncher(sharedTask);
    }
  }
  const startedAlready = async (): Promise<boolean> => {
    const [row] = await tasks.owned(source.id, { requestIds: [`app-${source.id}-${requestId}`] }).catch(() => [] as Delegation[]);
    return !!row && row.state !== "cancelled";
  };
  // SC-4: the commit this brief was written against, read once and carried with the call, so a worker that waits for a
  // free worker (or for a review) opens with the commit the first mate saw, not the one at its start.
  let briefStamp: string | undefined;
  /** What a held or queued call carries to its start: the stamp, when there is one. */
  const briefCarried = (): Record<string, unknown> => (briefStamp ? { briefStamp } : {});
  // WP-144: fresh-eyes review, off unless this project turned it on. It comes after every check that can refuse the call
  // cheaply (so a brief that would fail is never reviewed) and before anything starts. The review keeps the call as a
  // waiting task; Approve (or Skip once) asks tasks.delegate again under the same request ID, with the call that was
  // reviewed. The reviewers run after this call returns, so it never waits on them.
  const heldForReview = async () => {
    if (!tasks.freshEyes) return undefined;
    // A task already started for this request is read back below, never started again: nothing to review, and a
    // worker that was cancelled is not started again on the strength of an earlier approval.
    if (await startedAlready()) return undefined;
    // The reading list is capped here, so what is kept, reviewed and started is the same short list.
    const held = {
      ...input,
      ...(input.reading !== undefined ? { reading: readingEntries(input.reading) } : {}),
      ...briefCarried(),
    };
    const eyes = await tasks.freshEyes({
      project: source.cwd,
      requestId,
      plan: brief,
      ownerSession: source.id,
      reading: held.reading,
      held,
    });
    if (eyes?.hold !== true) return undefined;
    return {
      taskId: null,
      childSessionId: `app-${source.id}-${requestId}`,
      status: "waiting",
      title,
      freshEyes: true,
      note:
        typeof eyes.why === "string" && eyes.why.trim()
          ? eyes.why
          : "Fresh-eyes review: waiting on you",
    };
  };
  // WP-40: a bad gate is refused before a worker starts. Nothing named keeps the routes check alone.
  // SC-4: the project's own check ids go to the gates as they always did; a task with lines of its own is a code task.
  const gates = gateRequest({
    ...input,
    checks: own.ids,
    // (Even a `code: false` that came with lines: lines are checks to run, and the checks gate comes with them.)
    ...(own.lines.length && (input.code === undefined || input.code === false) ? { code: true } : {}),
  });
  // Hivra WP-10: never deeper than first mate, first mate, workers.
  if (tasks.checkDepth) await tasks.checkDepth(source.id);
  // WP-92: the keys a worker's environment holds. Checked before anything starts.
  const secretList = workerSecrets(input.secrets);
  // A stuck task of the caller's this one takes on (a retry, or one piece of a split): checked before anything starts.
  const redoes =
    input.redoes === undefined ? undefined : (await ownRows(source, tasks, [text(input.redoes, "redoes", 128)]))[0];
  if (input.lead !== undefined) {
    // SC-4: check lines and a do-not-touch list belong to a worker's brief. A Lead writes its own workers' briefs, so
    // these would be dropped; say so now rather than let them look accepted.
    if (own.lines.length || leave.length)
      throw new Error(
        "A brief to a Lead can't carry check lines or a do-not-touch list: the Lead writes its own workers' briefs. Say in the brief what the workers must check and leave alone, and the Lead puts it in theirs.",
      );
    if (redoes) throw new Error("redoes is for your own workers' tasks; leave it out when you brief a Lead.");
    if (secretList.length)
      throw new Error(
        "secrets are for a worker you start yourself; a Lead's delegation names its own workers' keys. Leave them out here.",
      );
    if (!owner.mono)
      throw new Error(
        "A coding-team chat hands its work to its own workers; only a Mono briefs a project's Lead. Leave out lead.",
      );
    // Every refusal this brief can meet comes before the review: what it names, and whether that Lead exists.
    const request = leadRequest(input, tasks);
    await tasks.checkLead?.(source, owner.mono, request.lead);
    // WP-156: the target Lead's project, not the chat that writes the brief.
    const leadHome = (await tasks.leadProject?.(source, owner.mono, request.lead))?.trim();
    const held = await heldForReview();
    if (held) return held;
    // A Lead is a first mate: its brief comes from the same template, read-only on the project.
    // WP-41: the brief names the pstack skills for this kind of work.
    const leadBrief = renderBrief(
      { intent, spec: brief },
      { kind: "first-mate" },
      classifyBriefTask(`${intent}\n${brief}`),
      extras,
    );
    return briefLead(source, owner.mono, tasks, {
      requestId,
      brief: leadBrief,
      title,
      asks,
      goal,
      // WP-156: the same project key the decision gate stores answers under (see firstMateTool).
      standingProject: leadHome || owner.team?.project || tasks.hubProjectId?.(source.cwd) || source.cwd,
      ...(sharedTask ? { taskId: sharedTask } : {}),
      input,
      gates,
      gateFolder: source.cwd,
    });
  }
  if (input.whenBusy !== undefined)
    throw new Error("whenBusy is for a brief to a Lead (lead); a worker starts in a chat of its own");
  const asked = input.isolation;
  if (asked !== undefined && asked !== "shared" && asked !== "worktree")
    throw new Error('isolation must be "shared" or "worktree"');
  // Hivra WP-10: a first mate's main checkout is watched for edits during its turn (checkout_guard.rs), so its workers
  // never work in it: a worker there would get the first mate flagged for the worker's own changes.
  const firstMate = isFirstMate(source);
  if (firstMate && asked === "shared")
    throw new Error(
      'A first mate\'s workers each work in a checkout of their own, never in the project\'s main one: leave out isolation (or use "worktree").',
    );
  if (input.heavy !== undefined && typeof input.heavy !== "boolean")
    throw new Error("heavy must be true or false");
  if (input.hard !== undefined && typeof input.hard !== "boolean")
    throw new Error("hard must be true or false");
  // The Lead's own call: this job runs heavy tests, so its project runs only so many like it at once.
  const heavy = input.heavy === true;
  // The job's size, as the Lead declared it, and its own "this one is hard": signals the model chooser reads (E7).
  const hard = input.hard === true;
  const scope = scopeList(input.scope);
  // r87: the files or folders it will change, as the Lead named them and as its brief names them, and its area (UI, API, docs). A job that shares one
  // with running work in the project waits for that work to land (workerPool.ts sharedWith).
  const files = [...new Set([...fileList(input.files), ...filesNamed(brief), ...areasNamed(title, brief)])];
  const named =
    input.project === undefined ? undefined : text(input.project, "project", 4096);
  // A coding-team chat works on its own project only: naming it is fine, naming another is not.
  if (owner.team && named !== undefined && named !== owner.team.project && (tasks.hubProjectFolder?.(named) ?? named) !== owner.team.folder)
    throw new Error(`A coding-team chat delegates on its own project (${owner.team.project}). Leave out project.`);
  // Every Mono but a Lead works through teams (hub/model/monoTeams.ts): a project's work goes to its coding team as a
  // brief to its Lead, and its own work to a worker in its own team's folder, made the first time.
  let ownTeam: { folder: string; name: string } | undefined;
  let makesOwnTeam = false;
  if (owner.mono && tasks.monoWork && !tasks.monoWork.isLead(owner.mono.id)) {
    const team = named !== undefined ? tasks.monoWork.codingTeam(named) : undefined;
    if (team)
      throw new Error(
        `${named} has a coding team: hand its work to ${team.name} instead, with delegate_task and lead "${team.projectId}" (the brief goes to ${team.leadName}, its workers show in ${team.name}, and its report comes back to you). A small fix you can make yourself, here.`,
      );
    if (named === undefined) {
      // A team's folder is no repository: its workers share it, never a checkout of their own.
      if (asked === "worktree")
        throw new Error(
          "Your own team's folder isn't a repository, so its workers share it: leave out isolation (or use \"shared\").",
        );
      makesOwnTeam = true;
    }
  }
  // A model the call names must be one this chat can ask for. Checked here, so a bad name is refused before a review.
  const onBridge = source.harness === "claude" && claudeRunsOnSubscriptionBridge();
  const askedModel = taskModel(input.model, source, onBridge);
  // A job Ash already answered in its worker's chat is his: refused before a review, as it is before a start.
  if (tasks.freshEyes && !(await startedAlready())) {
    const open = (await tasks.owned(source.id, {}).catch(() => [] as Delegation[])).filter(isOpenDelegation);
    const refusal = answeredJobRefusal(open, { requestId, title, ...(redoes ? { redoes } : {}) });
    if (refusal) throw new Error(refusal);
  }
  // SC-4: a code brief in a project that runs full checks on each task needs a check line, refused before a review or a
  // start. The app's own call (marked: a queued worker starting, a reviewed brief approved, a retry) is a brief already
  // accepted as sent, so a mode that changed meanwhile doesn't drop it. A Mono's own team folder is no project, so none
  // of this applies there.
  const briefFolder = briefFolderOf(source, owner, named, tasks);
  if (!makesOwnTeam) {
    if (!isAppDelegate(input)) {
      const refusal = await fullModeRefusal(
        tasks,
        briefFolder,
        isCodeBrief({ code: input.code, gates: input.gates, scope: input.scope }),
        own.lines,
      );
      if (refusal) throw new Error(refusal);
    }
    // A redo works in the copy its first worker left, with that work in it: it has nothing to drift from.
    if (!redoes) {
      briefStamp =
        validStamp(input.briefStamp) ?? validStamp(await tasks.briefStamp?.(briefFolder).catch(() => undefined));
    }
  }
  const held = await heldForReview();
  if (held) return held;
  // The Mono's own team is made now, once the brief may start: its folder is where this worker runs.
  if (makesOwnTeam && owner.mono && tasks.monoWork) ownTeam = await tasks.monoWork.ownTeam(owner.mono);
  // E7: a worker gets the right model for its job — Sonnet for a usual one, a stronger model (and high effort when it
  // offers one) for a hard one, and a project's own worker model for any of its jobs. A model or effort the caller
  // names always wins, and the route never touches another engine or one of Ash's own models (taskDifficulty.ts).
  // WP-141 LOW 7: the folder whose crew policy this launch reads. The pick and the launch share the same function.
  const policyFolder = crewScopeFolder(owner, source, named, tasks);
  const folder =
    ownTeam?.folder ??
    (named !== undefined && !owner.team ? tasks.hubProjectFolder?.(named) ?? named : source.cwd);
  // WP-171: a task that waits for another is held in this app's queue, which a remote project's host does not share.
  if (link?.after.length && [folder, source.cwd].some((path) => remoteProjectFor(path)))
    throw new Error(
      "A task that waits for another can't be held on a remote project yet. Send the tasks that need nothing from each other, and the rest once they report.",
    );
  const projectKey = tasks.hubProjectId?.(folder) ?? folder;
  const difficulty = judgeTask({ heavy, retry: Boolean(redoes), scope: scope.length, hard });
  // On the DeepSeek launcher a Claude name is only a label: a worker it names runs on DeepSeek.
  // On the DeepSeek launcher another engine's model runs as DeepSeek instead, and the Lead hears why.
  const offBridgeAsk =
    onBridge && askedModel !== undefined && askedModel.harness !== "claude" ? String(input.model) : undefined;
  const namedModel =
    onBridge && (offBridgeAsk || (askedModel?.harness === "claude" && isClaudeAliasModel(askedModel.model)))
      ? undefined
      : askedModel;
  // An effort alone keeps the route on the bridge (its model is still DeepSeek); off it, it keeps the chat's model.
  const route =
    namedModel || (input.effort !== undefined && !onBridge)
      ? undefined
      : withOffBridgeWhy(routeWorker(source, difficulty, tasks.pool?.model(projectKey), onBridge), offBridgeAsk);
  const model = namedModel ?? (route ? { harness: route.harness, model: route.model } : undefined);
  const effort = input.effort !== undefined ? input.effort : route?.effort;
  // WP-13: the crew route picks the CLI, model and effort. A failure, or a CLI that isn't available, keeps this one.
  let launchHarness = model?.harness;
  let launchModel = model?.model;
  let chosenEffort = effort;
  let crewChose = false;
  let ranFrom: string | undefined;
  // WP-89: a bench (verify_live.rs) starts only its own Claude wrapper. A worker routed to another CLI there is
  // refused in the bench's words after the route, never quietly started on Claude instead.
  let benchRefusal: string | undefined;
  // WP-89: outside a bench the routed CLI may simply not be installed. The worker keeps the chat's own CLI so the
  // work still starts, and this sentence says which CLI was asked for and what it runs on instead.
  let cliFallback: string | undefined;
  // WP-141: why the crew picked this CLI. Kept on the row and told to the Lead, so a pick is never silent.
  let crewWhy: string | undefined;
  // WP-141: the route forced a CLI and named none (every CLI on Never use, or the lock with none installed).
  let crewRefused: string | undefined;
  // WP-141: the route this launch was judged by. The gate checks the CLI it starts on against its lock.
  let crewAnswer: CrewRouteAnswer | null | undefined;
  if (tasks.crewRoute) {
    const baseline = model?.harness ?? source.harness;
    const baselineModel = model?.model ?? source.model;
    const roleLabel =
      input.role === undefined ? undefined : text(input.role, "role", 40).toLowerCase();
    // WP-141 MEDIUM 4: a route that can't be read refuses the start. It never starts on the Lead's or the chat's CLI.
    try {
      const override = callerOverride(namedModel, input.effort);
      const monoRules = carriedMonoRules(owner.mono?.crewRules);
      const defaults = routeDefaults({
        mono: owner.mono?.workerDefault,
        project: await projectDefaultFor(tasks, policyFolder),
        system: tasks.pool?.systemDefault?.(),
      });
      const catalog = launchCatalog();
      crewAnswer = await tasks.crewRoute({
        labels: [
          ...new Set([...(roleLabel ? [roleLabel] : []), ...crewLabels(areasNamed(title, brief))]),
        ],
        paths: crewPaths(fileList(input.files), filesNamed(brief)),
        ...(override ? { override } : {}),
        project: policyFolder,
        ...(owner.mono?.id ? { mono: owner.mono.id } : {}),
        ...(monoRules.length ? { monoRules } : {}),
        ...(defaults ? { defaults } : {}),
        ...(Object.keys(catalog).length ? { catalog } : {}),
      });
    } catch (error) {
      throw new Error(crewReadRefusal(error, "The crew policy could not be read, so no worker was started"));
    }
    try {
      const answer = crewAnswer;
      const named = { harness: baseline, model: baselineModel, effort };
      crewRefused = crewRefusal(answer, named);
      const next = applyCrewLaunch(answer, named);
      if (next.harness && isHarnessAvailable(next.harness)) {
        // Only when the CLI it names is the one this worker runs on; a missing CLI says so in cliFallback instead.
        if (answer?.cli && answer.cli === next.harness) crewWhy = routeReason(answer) || undefined;
        const moved = next.harness !== baseline || next.model !== baselineModel || next.effort !== effort;
        if (moved) {
          crewChose = next.harness !== model?.harness || next.model !== model?.model;
          launchHarness = next.harness;
          launchModel = next.model;
          chosenEffort = next.effort;
          if (answer) ranFrom = ranFromPhrase(answer);
        }
      } else if (next.harness && next.harness !== baseline) {
        const refused = benchCliRefusal(next.harness);
        // WP-141 HIGH 1: a fallback never starts a CLI on Never use, and never gets past the lock.
        const stuck = fallbackRefusal(answer, baseline, next.harness);
        if (refused) benchRefusal = refused;
        else if (stuck) crewRefused = stuck;
        else cliFallback = cliFallbackLine(next.harness, baseline);
      }
    } catch {
      // A timeout is not a final failure: the model already chosen still starts.
    }
  }
  if (benchRefusal) throw new Error(benchRefusal);
  if (crewRefused) throw new Error(crewRefused);
  // WP-60: a remote project keeps the brief on its host. A local folder is unchanged. WP-141: the gate judges the chat's
  // CLI the host will run (remote briefs take the chat's harness), before anything reaches the host.
  if ([folder, source.cwd].some((path) => remoteProjectFor(path)))
    await gateCrewStart(tasks, {
      cli: source.harness,
      folder: policyFolder,
      mono: owner.mono?.id,
      route: crewAnswer,
      sessionId: `app-${source.id}-${requestId}`,
      parentSession: source.id,
    });
  // SC-4: what a worker's brief adds to the shared parts: the stamp, its in-scope paths, its check lines and its list.
  const workerExtras = { ...extras, ...(briefStamp ? { stamp: briefStamp } : {}), scope, checks: own.lines, leave };
  const remoteBrief = await briefOnRemoteHost({
    paths: [folder, source.cwd],
    launchKey: `app-${source.id}-${requestId}`,
    ownerSession: source.id,
    title,
    harness: source.harness,
    model: source.model,
    runtimeMode: WORKER_RUNTIME_MODE,
    startedBy: firstMate ? "first-mate" : "person",
    promptFor: (hostCwd) =>
      briefPrompt(
        owner.name,
        renderBrief(
          { intent, spec: brief },
          { kind: "shared", folder: hostCwd },
          classifyBriefTask(`${intent}\n${brief}`),
          workerExtras,
        ),
        goal,
      ),
  });
  if (remoteBrief) return remoteBrief;
  // The worker works on this chat's project (hub/model/hubMcp.ts), so its brief carries that project's memory.
  const memory = await (tasks.memoryBrief ?? workerMemoryBlock)(
    source.id,
    launchHarness ?? model?.harness ?? source.harness,
  ).catch(
    () => undefined,
  );
  // The first mate's own crew rules (monos/model/crewRules.ts), read fresh for each brief.
  const crewRules = owner.mono ? await readCrewRules(owner.mono.id, owner.name) : undefined;
  const id = `app-${source.id}-${requestId}`;
  // Idempotent (H8c): a task already recorded for this request is never started a second time, so a waiting worker
  // asked again after a window died mid-start (its claim ran out) or a retried call only reads it back.
  const [already] = await tasks.owned(source.id, { requestIds: [id] }).catch(() => [] as Delegation[]);
  if (already && already.state !== "cancelled") {
    if (sharedTask) bindCrew(already.id, sharedTask);
    // A redo's link is kept on the retry too (round 5): the gate has it at once, and the row keeps it. A refused link
    // refuses the call.
    if (redoes) {
      addSpendRedoLink(id, redoes.childSession);
      await tasks.redo?.(source.id, redoes, already.id);
    }
    tasks.pool?.started({ id, heavy, files });
    // A retry after a save that didn't land keeps the same plan. A save that fails still returns the task.
    await keepGates(tasks, already.id, gates, folder);
    // SC-4: the first keep wins, so this never overwrites a result the gates already wrote.
    const keptAgain = await keepBrief(tasks, already.id, { stamp: briefStamp, checks: own.lines, leave });
    return {
      taskId: already.id,
      childSessionId: id,
      status: already.state,
      title: already.title ?? title,
      alreadyStarted: true,
      ...(keptAgain ? {} : { briefNote: BRIEF_NOT_KEPT }),
      ...(cliFallback ? { cliFallback } : {}),
      note: `${cliFallback ? `${cliFallback} ` : ""}This task had already started; it was not started again. Its report comes back to you as its own turn.`,
    };
  }
  // The workers this chat still has out: each holds a port, and one working in the same project shares its repo.
  const out = (await tasks.owned(source.id, {}).catch(() => [] as Delegation[])).filter(isOpenDelegation);
  // r86: a job Ash already answered in its worker's chat is his: no redo, no second worker on it (once per request).
  const refusal = answeredJobRefusal(out, { requestId, title, ...(redoes ? { redoes } : {}) });
  if (refusal) throw new Error(refusal);
  // Every chat's workers, where the app knows them: a Lead's and its coding-team chats' share one repo and the ports.
  const everyone = [...out, ...(tasks.pool?.openRows() ?? []).filter((row) => row.childSession !== id)];
  const port = workerPort(
    id,
    new Set(everyone.flatMap((row) => (row.brief ? [portOfBrief(row.brief)].filter((p): p is number => !!p) : []))),
  );
  // Hivra WP-10: the brief from the template, with the isolation check this launch needs.
  const isolationOf = (workspaceMode: "worktree" | "current", worktreeCwd?: string): BriefIsolation =>
    workspaceMode === "worktree" || worktreeCwd
      ? { kind: "own-checkout", mainCheckout: folder }
      : { kind: "shared", folder };
  const launchWith = (workspaceMode: "worktree" | "current", worktreeCwd?: string) =>
    helpers.startLaunch(
      source,
      {
        ...(worktreeCwd ? { worktreeCwd } : {}),
        prompt: briefPrompt(
          owner.name,
          renderBrief(
            { intent, spec: brief },
            isolationOf(workspaceMode, worktreeCwd),
            // WP-41: the brief names the pstack skills for this kind of work.
            classifyBriefTask(`${intent}\n${brief}`),
            workerExtras,
          ),
          goal,
          memory,
          [workerRules(port), crewRules].filter(Boolean).join("\n\n"),
        ),
        // PM's r63 run: a worker tab was named from the brief's first line ("Ash's words, verbatim: …"); it is the job.
        title,
        ...(ownTeam
          ? { project: ownTeam.folder }
          : named !== undefined && !owner.team
            ? { project: tasks.hubProjectFolder?.(named) ?? named }
            : {}),
        ...(launchHarness ? { harness: launchHarness } : {}),
        ...(launchModel ? { model: launchModel } : {}),
        ...(chosenEffort !== undefined ? { effort: chosenEffort } : {}),
        ...(ranFrom ? { ranFrom } : {}),
        // WP-89: the start card says when the CLI this Mono asked for isn't installed, and what it runs on instead.
        ...(cliFallback ? { cliFallback } : {}),
        // Workers run with full access so a permission prompt never strands them with nobody watching; Ash's own
        // hooks (his red-line guards) still run, and their questions go to this Mono (docs/PHASE-2-DESIGN.md H4).
        runtimeMode: WORKER_RUNTIME_MODE,
        workspaceMode,
      },
      host,
    );
  let launch = launchWith(asked === "worktree" ? "worktree" : "current");
  // A redo of a job (redoes) works where that job did: its worker's own checkout, so the half-done work is there, or a
  // fresh one when it had none left. Never the shared checkout unless the chat said "shared" (28 Oct: three redoes
  // started in the main checkout and had to cd into the first worker's worktree by hand).
  const redo = redoes && !ownTeam && asked === undefined ? await redoCheckout(redoes, host, launch.cwd) : undefined;
  if (redo) launch = redo.path ? launchWith("current", redo.path) : launchWith("worktree");
  // Several workers in one repo at once each get a checkout of their own unless the chat said "shared": the baseline
  // (20 Oct) had two in one checkout stopping each other's dev server. A first mate's workers always do (WP-10).
  const projectOf = (folder: string) => tasks.hubProjectId?.(folder) ?? folder;
  // Never in a Mono's own team: its folder is no repository (the checkout would never be made, and the worker never run).
  const auto =
    !redo &&
    !ownTeam &&
    asked === undefined &&
    (firstMate || everyone.some((row) => (row.project ?? "") === projectOf(launch.cwd)));
  if (auto) launch = launchWith("worktree");
  const hubProject = tasks.hubProjectId?.(launch.cwd);
  // WP-92: a worker's keys are checked, approved by the person where needed, and armed for its session before it
  // starts. Nothing is armed unless every key is ready, and none of the words here carries a value.
  if (secretList.length) {
    if (!owner.mono)
      throw new Error(
        "A worker's key comes from a Mono's own chat: the approvals are the Mono's. A coding-team chat hands this work to its Lead, whose own delegation names the key.",
      );
    if (!host.secretsWorkerArm) throw new Error("Keys aren't available in this build");
    const armed = await host.secretsWorkerArm(id, {
      chat: source.id,
      mono: owner.mono.id,
      project: folder,
      executable: launch.harness,
      secrets: secretList,
    });
    if (armed.state !== "ready") {
      const note =
        armed.state === "waiting"
          ? forUser`The person hasn't approved ${armed.name} for this worker yet. Tell them in one line what the worker will run, then end your turn; their answer comes back to you and you delegate again.`
          : armed.state === "denied"
            ? forUser`The person said no to ${armed.name}. Carry on without it, or ask again later with the reason it is needed.`
            : forUser`No key named ${armed.name} is saved. Ask for it with secrets_request, then delegate again.`;
      return {
        taskId: null,
        childSessionId: id,
        status: armed.state === "denied" ? "refused" : "waiting",
        title,
        cwd: launch.cwd,
        harness: launch.harness,
        model: launch.model,
        note,
      };
    }
  }
  // Over the project's limit, or the provider has no account with room: it waits and starts by itself (H8).
  if (tasks.pool) {
    const job = {
      id,
      project: projectOf(launch.cwd),
      projectName: ownTeam?.name ?? projectName(launch.cwd),
      heavy,
      harness: launch.harness,
      ...(files.length ? { files } : {}),
    };
    // WP-161: look at the machine first, so a pause the person set applies to the very first launch too.
    await tasks.pool.refreshHealth?.();
    const admission = tasks.pool.admit({ ...job, ownerSession: source.id, ...(link ? { fanout: link } : {}) });
    if (!admission.start) {
      tasks.pool.enqueue(
        {
          ...job,
          ownerSession: source.id,
          requestId,
          title,
          queuedAt: (tasks.now ?? Date.now)(),
          input: {
            ...input,
            ...(originalRequest
              ? {
                  originalRequest,
                  ...(originalRequestChars !== undefined ? { originalRequestChars } : {}),
                }
              : {}),
            // SC-4: the stamp and the acceptance travel with the call, so its start writes the brief it was sent with.
            ...briefCarried(),
          },
        },
        launch,
      );
      return {
        taskId: null,
        childSessionId: id,
        status: "waiting",
        waiting: admission.line,
        title,
        cwd: launch.cwd,
        harness: launch.harness,
        model: launch.model,
        ...(launchEffort(launch) ? { effort: launchEffort(launch) } : {}),
        ...(launchModelName(launch) ? { modelName: launchModelName(launch) } : {}),
        ...(route && !crewChose ? { modelWhy: route.why } : {}),
        ...(heavy ? { heavy: true } : {}),
        ...(cliFallback ? { cliFallback } : {}),
        note: forUser`${cliFallback ? `${cliFallback} ` : ""}${admission.line}${admission.reason === "files" ? " If this work belongs with that job, cancel this one (task_cancel) and send that job a follow-up instead; otherwise leave it." : ""} It starts by itself, in the order you asked, and reports back to you like any other task once it has run; there is nothing for you to do about it (task_cancel with its childSessionId as taskId takes it back). Tell Ash in one line what is running and what waits (in plain words: never a task id or a folder path; never the raw model id; r91: its model goes on a line of its own under that line, exactly as modelName says, never mid-sentence), then end your turn.`,
      };
    }
  }
  // A redo's link is known to the spend gate before the worker's first turn (round 5): its chat sums its parent's spend.
  if (redoes) addSpendRedoLink(id, redoes.childSession);
  const meta = {
    title,
    askIds: asks,
    ...(redoes ? { redoes: { id: redoes.id, childSession: redoes.childSession } } : {}),
    ...(goal ? { goal } : {}),
    ...(hubProject ? { project: hubProject } : {}),
    ...(sharedTask ? { taskId: sharedTask } : {}),
    ...(crewWhy ? { pickReason: crewWhy } : {}),
  };
  // Always monitored: a task reports back to the chat that delegated it. WP-141: the gate runs before each start.
  const gated = () =>
    gateCrewStart(tasks, {
      cli: launch.harness,
      folder: policyFolder,
      mono: owner.mono?.id,
      route: crewAnswer,
      sessionId: id,
      parentSession: source.id,
    });
  try {
    await gated();
    await host.start(launch, id, undefined, source.id, meta);
  } catch (error) {
    // A checkout of its own couldn't be made (a folder that isn't a git repository): the shared one, as asked for.
    if (!auto && !(redo && !redo.path)) throw error;
    launch = launchWith("current");
    await gated();
    await host.start(launch, id, undefined, source.id, meta);
  }
  tasks.pool?.started({ id, heavy, files });
  helpers.fileStarted(source, launch, id, host);
  const [row] = await tasks.owned(source.id, { requestIds: [id] });
  // WP-84: the pull request for this crew can name the task's phase documents.
  if (sharedTask && row?.id) bindCrew(row.id, sharedTask);
  // WP-40: the plan is kept once the row exists. A waiting worker stores `input` and this runs when it starts.
  await keepGates(tasks, row?.id, gates, folder);
  // SC-4: its check lines, do-not-touch list and the stamp its brief opens with, once the row exists.
  const kept = await keepBrief(tasks, row?.id, { stamp: briefStamp, checks: own.lines, leave });
  // What the Lead did about its stuck task shows on that task's card (and survives a restart: it's in its row's log).
  if (redoes && row) await tasks.redo?.(source.id, redoes, row.id).catch(() => undefined);
  return {
    taskId: row?.id ?? null,
    childSessionId: id,
    status: row?.state ?? "running",
    title,
    // SC-4: lines or a list that could not be saved are not run or enforced; the first mate is told, and can send it again.
    ...(kept ? {} : { briefNote: BRIEF_NOT_KEPT }),
    cwd: launch.cwd,
    harness: launch.harness,
    model: launch.model,
    // The effort it runs at, as the picker words it, so the Lead can say it and the card shows the same value.
    ...(launchEffort(launch) ? { effort: launchEffort(launch) } : {}),
    // The model and effort in Ash's words: what the Lead says, never the raw model id.
    ...(launchModelName(launch) ? { modelName: launchModelName(launch) } : {}),
    // Why this model, when the app picked it from the job (E7): the Lead can pass it on in plain words.
    ...(route && !crewChose ? { modelWhy: route.why } : {}),
    // WP-89: the CLI asked for isn't installed, so the worker runs on this chat's CLI; the Lead passes the line on.
    ...(cliFallback ? { cliFallback } : {}),
    // WP-141: why the crew picked this CLI, in plain words the Lead can pass on.
    ...(crewWhy ? { crewWhy } : {}),
    ...(launch.workspaceMode === "worktree" || (redo?.path && launch.worktreeCwd) ? { isolation: "worktree" } : {}),
    ...(auto && launch.workspaceMode === "worktree"
      ? {
          isolationWhy: firstMate
            ? "A first mate's workers each have a checkout of their own; the project's main checkout stays as it is."
            : "Another worker is working in this project, so this one has a checkout of its own.",
        }
      : {}),
    ...(redo && (launch.workspaceMode === "worktree" || launch.worktreeCwd)
      ? {
          isolationWhy: redo.path
            ? "A redo of that task, so it works in the same checkout its first worker used, with its work still there."
            : "A redo of that task, whose first worker left no checkout, so this one has a fresh checkout of its own.",
        }
      : {}),
    ...(heavy ? { heavy: true } : {}),
    // Its port, which its brief tells it to use for any server it starts.
    port,
    // Work of a Mono's own runs in its team: the worker's chat shows there, under the Mono's.
    ...(ownTeam ? { team: ownTeam.name } : {}),
    note: row
      ? forUser`${cliFallback ? `${cliFallback} ` : ""}Running${ownTeam ? ` in ${ownTeam.name}, where its chat shows under yours` : ""}. Its report comes back to you as its own turn soon after it finishes. Start any other independent work now, tell Ash in one line what is running (in plain words: never its task id or a folder path; never the raw model id; r91: its model goes on a line of its own under that line, exactly as modelName says, never mid-sentence) and end your turn; whenever he writes meanwhile, answer him at once.`
      : `${cliFallback ? `${cliFallback} ` : ""}It started, but its task record could not be stored; its report still comes back to you.`,
  };
}

/**
 * WP-171, delegate_tasks: one call for a multi-part ask whose tasks name what each owns, provides, requires and checks.
 * The whole contract is checked before anything starts. Then every task goes through the same `delegate` a single
 * delegate_task does (its brief, gates, crew route, worker limits, checkout): the tasks that need nothing start, and a
 * task that requires a name waits in the worker queue until the task that provides it is delivered and checked
 * (fanoutWaves.ts, fanoutChecks.ts), starting by itself then. A task that cannot start holds the tasks that need it.
 */
/** WP-172: the plans this app is sending right now, by owner and plan id. A resume of one of them waits its turn. */
const SENDING_PLANS = new Set<string>();

/** The one plain line a second send or resume of a plan gets, from this window or another. */
const PLAN_BUSY = "This plan is already being sent, from this window or another. Wait for its answer, then check task_status.";

/** How often a window that is sending a plan renews its lease (the lease itself lasts LEASE_MS in the database). */
const LEASE_RENEW_MS = 30_000;

/**
 * WP-172: runs one send or resume of a plan. The plan's lease in the database is taken first, so only one window of
 * the app sends or resumes a given plan at a time; a second window is refused in plain words. The lease is renewed
 * while the send runs and given up at the end, and a lease whose window died runs out and can be taken over.
 */
async function sendingPlan<T>(
  owner: string,
  planId: string,
  store: FanoutCheckpointStore | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${owner}\n${planId}`;
  if (SENDING_PLANS.has(key))
    throw new Error(PLAN_BUSY);
  SENDING_PLANS.add(key);
  const holder = windowHolder();
  let renew: ReturnType<typeof setInterval> | undefined;
  let held = false;
  try {
    if (store) {
      held = await store.acquire(owner, planId, holder);
      if (!held) throw new Error(PLAN_BUSY);
      renew = setInterval(() => void store.renew(owner, planId, holder).catch(() => false), LEASE_RENEW_MS);
    }
    return await run();
  } finally {
    if (renew !== undefined) clearInterval(renew);
    SENDING_PLANS.delete(key);
    if (held && store) await store.release(owner, planId, holder).catch(() => false);
  }
}

/** Said once to the owner when a plan's progress could not be saved: it then cannot be resumed after a crash. */
const CHECKPOINT_NOTE =
  "Could not save this plan's progress, so it cannot be resumed if the app stops. Tell Ash in one line.";

/**
 * A checkpoint writer for one plan: each change is saved as the next revision. A failed or refused save never fails the
 * plan by itself, but it is remembered, so the owner is told once that the plan cannot be resumed. The write answers
 * whether it was saved, for the one caller that must not go on without it (a resume's own number).
 */
function planWriter(store: FanoutCheckpointStore | undefined, owner: string, first: FanoutCheckpoint | undefined) {
  let current = first;
  let failed = false;
  return {
    get: () => current,
    /** WP-172: the checkpoint note for the result, when a write failed or was refused. */
    note: (): { checkpointNote: string } | Record<string, never> => (failed ? { checkpointNote: CHECKPOINT_NOTE } : {}),
    async write(change: (cp: FanoutCheckpoint) => FanoutCheckpoint): Promise<boolean> {
      if (!store || !current) return false;
      current = change(current);
      const saved = await store.save(owner, current).catch(() => false);
      if (!saved) failed = true;
      return saved;
    },
    /** Once every task has started or been refused, the plan is no longer offered for a resume. */
    async finish(): Promise<void> {
      if (!store || !current || !isComplete(current)) return;
      await store.remove(owner, current.id).catch(() => false);
    },
  };
}

/**
 * The request id a task's last start was sent under: the plan's own id for the task, unless a start again took a new
 * one (then the stopped row is left as it is, and the new worker has a row of its own).
 */
function requestOf(plan: FanoutCheckpoint, name: string): string {
  return plan.tasks.find((task) => task.name === name)?.requestId ?? taskRequestId(plan.id, name);
}

/** The rows of a plan's tasks, read by the child session each start was given. */
function rowsOfPlan(owner: string, plan: FanoutCheckpoint, owned: readonly Delegation[]): RowLookup {
  return (name) => {
    const child = `app-${owner}-${requestOf(plan, name)}`;
    const row = owned.find((entry) => entry.childSession === child);
    return row ? { id: row.id, childSession: row.childSession, state: row.state } : undefined;
  };
}

/** The child session of a task's start (the app's own `app-<owner>-<request>` form). */
function childOf(owner: string, plan: FanoutCheckpoint, name: string): string {
  return `app-${owner}-${requestOf(plan, name)}`;
}

const PLAN_READ_FAILED = "Could not read this plan's tasks, so nothing was started or changed. Try again.";
const RESUME_NOT_SAVED = "Could not save this plan's resume, so nothing was started again. Try again.";

/**
 * WP-172: one plan's rows, in one read: the store refuses more than 20 requests at once, so a plan is never read with
 * another. A read that fails throws; it is never taken for "no row" (a running task would look stopped).
 */
async function readPlanRows(owner: string, plan: FanoutCheckpoint, tasks: AgentAppTasksHost): Promise<Delegation[]> {
  const requestIds = plan.tasks.map((task) => `app-${owner}-${requestOf(plan, task.name)}`);
  return tasks.owned(owner, { requestIds }).catch(() => {
    throw new Error(PLAN_READ_FAILED);
  });
}

/**
 * The children still waiting in this window's worker queue, or held for review: their jobs have no row yet. A read that
 * fails throws: a held brief taken for "no job" would look stopped, and a second worker would start for it.
 */
async function waitingChildren(owner: string, tasks: AgentAppTasksHost): Promise<Set<string>> {
  const waiting = new Set<string>();
  for (const entry of tasks.pool?.queued(owner) ?? []) waiting.add(entry.job.id);
  if (tasks.freshEyesWaiting) {
    const held = await tasks.freshEyesWaiting(owner).catch(() => {
      throw new Error(HELD_READ_FAILED);
    });
    for (const entry of held) waiting.add(entry.childSessionId);
  }
  return waiting;
}

const HELD_READ_FAILED = "Could not read which tasks are held for review, so nothing was started or changed. Try again.";

/** The yes and no a stopped task's decision offers (WP-14). Asked under a stable key, so asking again changes nothing. */
const AGAIN_YES = "Start it again";
const AGAIN_NO = "Leave it stopped";

/**
 * WP-172: the decision that starts a stopped task again. It names the plan, the task and the request id the stopped start
 * had, so each stop asks afresh: a yes given for one stop starts nothing after a second one. The tag is a hash of the
 * chat that owns the plan and all three names, so two chats that picked the same plan id and task name get two keys
 * (Ash's yes for one chat never restarts the other's task). The `fanout-again/` prefix is what person_only and the
 * ask refusals match.
 */
export function fanoutAgainKey(owner: string, plan: string, name: string, stopped: string): string {
  const tag = sha256Hex(`${owner}\n${plan}\n${name}\n${stopped}`).slice(0, 16);
  return `fanout-again/${plan}/${name}/${stopped}/${tag}`;
}

/** Whether a decision key is a restart decision (the trimmed key, as the store reads it). */
export function isAgainKey(key: unknown): boolean {
  return typeof key === "string" && isFanoutAgainDecisionKey(key);
}

/**
 * WP-14: asks Ash whether a stopped task starts again, as a decision of its own. True only when Ash has answered yes, and
 * not through a chat (a chat's answer is the model's, whatever the words); the model's `confirm` alone never starts a
 * worker. Without a first mate's decision store, nothing can be asked.
 */
async function askAgain(
  source: Session,
  plan: FanoutCheckpoint,
  name: string,
  where: { mono?: string; project?: string },
  firstMate: FirstMateTasksHost | undefined,
): Promise<boolean> {
  if (!firstMate) return false;
  const question = `Start the "${name}" task again? Its worker stopped or went missing, and a repeat can do its work twice.`;
  const { result, answeredBy, question: stored, options } = await askPersonRecorded(
    source,
    {
      key: fanoutAgainKey(source.id, plan.id, name, requestOf(plan, name)),
      question,
      options: [AGAIN_YES, AGAIN_NO],
      recommended: AGAIN_NO,
    },
    where,
    [],
    firstMate,
  );
  if (answeredBy?.startsWith("chat:")) return false;
  // The card must be the app's own: a card made first under this key with other words is not Ash's answer to this question.
  if (stored !== question || options.length !== 2 || options[0] !== AGAIN_YES || options[1] !== AGAIN_NO) return false;
  return result.state === "answered" && result.answer === AGAIN_YES;
}

async function fanout(
  source: Session,
  requestId: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  helpers: TaskHelpers,
) {
  // A fan-out's tasks are all workers, so the Chief of Staff never sends one.
  refuseCaptainCrew(source, host, false);
  if (input.resume !== undefined) {
    if (input.tasks !== undefined)
      throw new Error("A resume carries on a plan already sent: leave out tasks (name the stopped ones in confirm).");
    const planId = text(input.resume, "resume", 100);
    return sendingPlan(source.id, planId, taskOwner(source, host).tasks.fanoutCheckpoints, () =>
      resumeFanout(source, planId, input, host, helpers),
    );
  }
  return sendingPlan(source.id, requestId, taskOwner(source, host).tasks.fanoutCheckpoints, () =>
    sendFanout(source, requestId, input, host, helpers),
  );
}

/**
 * WP-172: a plan an earlier run did not finish (a crash, a restart, a quit mid-plan). What never started is sent now,
 * what started is kept as it is, and a task whose worker was stopped or has gone is sent again only when `confirm`
 * names it. Every start keeps the plan's request id, so a task that already has a row is never started a second time.
 */
async function resumeFanout(
  source: Session,
  planId: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  helpers: TaskHelpers,
) {
  const { tasks } = taskOwner(source, host);
  if (input.confirm !== undefined && (!Array.isArray(input.confirm) || input.confirm.some((name) => typeof name !== "string")))
    throw new Error("confirm must be a list of the task names to start again");
  const confirm = (input.confirm as string[] | undefined) ?? [];
  const store = tasks.fanoutCheckpoints;
  const found = store ? (await store.list(source.id).catch(() => [] as FanoutCheckpoint[])).find((cp) => cp.id === planId) : undefined;
  if (!found) throw new Error("There is no unfinished plan with that id. Send the tasks again with delegate_tasks.");
  const unknown = confirm.filter((name) => !found.tasks.some((task) => task.name === name));
  if (unknown.length)
    throw new Error(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not part of this plan.`);
  const now = (tasks.now ?? Date.now)();
  // Everything is read before anything is decided: a read that fails throws here, and nothing has changed yet.
  const owned = await readPlanRows(source.id, found, tasks);
  const waiting = await waitingChildren(source.id, tasks);
  const rowOf = rowsOfPlan(source.id, found, owned);
  const plan: ResumePlan = planResume(found, rowOf, (name) => waiting.has(childOf(source.id, found, name)));
  const writer = planWriter(store, source.id, found);
  // The resume's number is saved before anything starts. A resume whose number was not saved starts nothing: the next
  // one would take the same number, and a start again under it could revive a row that was stopped.
  const counted = await writer.write((cp) => ({ ...cp, resumes: cp.resumes + 1, revision: cp.revision + 1, updatedAt: now }));
  if (!counted) throw new Error(RESUME_NOT_SAVED);
  const generation = found.resumes + 1;
  for (const adopted of plan.adopt)
    await writer.write((cp) => noteStarted(cp, adopted.name, { taskId: adopted.taskId, childSession: adopted.childSession, status: adopted.state }, now));
  const outcome = new Map<string, string>();
  for (const name of plan.kept) outcome.set(name, "kept");
  for (const name of plan.refused) outcome.set(name, "refused earlier, not retried");
  for (const name of plan.waiting) {
    outcome.set(name, "waiting for a free worker");
    const child = childOf(source.id, found, name);
    await writer.write((cp) => noteQueued(cp, name, child, now));
  }
  // WP-14: a stopped task starts again only on Ash's yes to its own decision, and only when the call names it too.
  const { owner } = taskOwner(source, host);
  const where = { ...(owner.mono ? { mono: owner.mono.id } : {}), project: owner.team?.project ?? tasks.hubProjectId?.(source.cwd) ?? source.cwd };
  const restart = new Set<string>();
  for (const name of plan.confirm) {
    const yes = await askAgain(source, found, name, where, tasks.firstMate);
    if (yes && confirm.includes(name)) {
      restart.add(name);
      continue;
    }
    outcome.set(name, yes ? "answered yes; name it in confirm to start it again" : "needs your yes");
    await writer.write((cp) => noteStopped(cp, name, now));
  }
  const send = new Set([...plan.start, ...restart]);
  // In the plan's own order, so the waves still run in order.
  for (const task of found.tasks.filter((entry) => send.has(entry.name))) {
    // A start again gets a request id of its own; any other start keeps the one it had (a crashed one is adopted by it).
    const sentAs = restart.has(task.name) ? restartRequestId(found.id, task.name, generation) : requestOf(found, task.name);
    // A start again is recorded as the stopped task it was first: a task still marked started would keep its old request
    // id, and the tasks waiting on it would look for the stopped chat.
    // Nothing starts unless its "starting" (and, for a start again, its "stopped") is saved: a start whose record is not
    // there could be sent twice after a crash. With no store there is no record to keep, and the start goes on as before.
    const stoppedSaved = restart.has(task.name) ? await writer.write((cp) => noteStopped(cp, task.name, now)) : true;
    const startingSaved = await writer.write((cp) => noteStarting(cp, task.name, now, sentAs));
    if (store && !(stoppedSaved && startingSaved)) {
      outcome.set(task.name, "not started: could not save this plan's progress");
      continue;
    }
    try {
      const out = (await delegate(
        source,
        sentAs,
        {
          ...task.input,
          ...(found.originalRequest
            ? {
                originalRequest: found.originalRequest,
                ...(found.originalRequestChars !== undefined ? { originalRequestChars: found.originalRequestChars } : {}),
              }
            : {}),
        },
        host,
        helpers,
      )) as Record<string, unknown>;
      if (typeof out.taskId === "string" && typeof out.childSessionId === "string") {
        const status = typeof out.status === "string" ? out.status : undefined;
        await writer.write((cp) =>
          noteStarted(cp, task.name, { taskId: out.taskId as string, childSession: out.childSessionId as string, status }, now),
        );
      } else if (out.status === "waiting" && typeof out.childSessionId === "string") {
        const child = out.childSessionId;
        await writer.write((cp) => noteQueued(cp, task.name, child, now));
      }
      outcome.set(
        task.name,
        out.alreadyStarted === true ? "kept" : out.status === "waiting" ? "waiting for a free worker" : "started",
      );
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await writer.write((cp) => noteRefused(cp, task.name, why, now));
      outcome.set(task.name, `refused: ${why}`);
    }
  }
  await writer.finish();
  return {
    plan: found.id,
    tasks: found.tasks.map((task) => ({ name: task.name, status: outcome.get(task.name) ?? "kept" })),
    ...writer.note(),
    note: forUser`${describeResume(plan)} Tell Ash in one line what carried on and what waits for his yes (in plain words: never a task id, a task name or a folder path), then end your turn.`,
  };
}

async function sendFanout(
  source: Session,
  requestId: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  helpers: TaskHelpers,
) {
  const { owner, tasks } = taskOwner(source, host);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    throw new Error("request ID must use letters, digits, underscores or hyphens (up to 100)");
  const parsed = parseFanout(input);
  // SC-4: a code task of a project that runs full checks needs a check line. Refused for the whole plan, before any task
  // starts, naming the task. A Mono's own team folder is no project (as in `delegate`).
  for (const task of parsed.tasks) {
    const named = typeof task.passthrough.project === "string" ? task.passthrough.project : undefined;
    const ownTeamWork = !!owner.mono && !!tasks.monoWork && !tasks.monoWork.isLead(owner.mono.id) && named === undefined;
    if (ownTeamWork) continue;
    const refusal = await fullModeRefusal(tasks, briefFolderOf(source, owner, named, tasks), task.codeBrief, task.checkLines);
    if (refusal) throw new Error(`Task ${task.name}: ${refusal}`);
  }
  const planned = planFanout(parsed, source.id, requestId, (tasks.now ?? Date.now)());
  if (planned.links.some((link) => link.after.length) && !tasks.pool?.waitsOnProviders)
    throw new Error(
      "This build starts every task at once, so a task can't wait for one it needs. Send the tasks that need nothing now with delegate_task, and the rest after they report.",
    );
  // One request for the whole plan, read once and cut to the quote budget: the tasks that wait keep it, whatever
  // the person says meanwhile. The real length travels with it so the cut note stays honest.
  const takenRequest = readOriginalRequest(source.blocks);
  const originalRequest = takenRequest?.text || undefined;
  const originalRequestChars = takenRequest && takenRequest.chars > takenRequest.text.length ? takenRequest.chars : undefined;
  const linkOf = new Map(planned.links.map((link) => [link.name, link]));
  const taskOf = new Map(parsed.tasks.map((task) => [task.name, task]));
  /** The delegate input of one task, as a resume replays it (the person's request is kept once, on the plan). */
  const delegateInput = (name: string): Record<string, unknown> => {
    const link = linkOf.get(name)!;
    const task = taskOf.get(name)!;
    return {
      intent: task.intent,
      brief: task.brief,
      goal: task.goal,
      ...(task.title ? { title: task.title } : {}),
      ...(task.files.length ? { files: task.files } : {}),
      ...(task.gates ?? {}),
      // SC-4: the task's own check lines go beside the project's check ids, and its do-not-touch list with them.
      ...(task.checkLines.length ? { checks: [...(task.gates?.checks ?? []), ...task.checkLines] } : {}),
      ...(task.leave.length ? { leave: task.leave } : {}),
      ...task.passthrough,
      fanout: link,
    };
  };
  // WP-172: the plan is written before the first start, so a crash from here on can be resumed.
  const plans = tasks.fanoutCheckpoints;
  const writer = planWriter(
    plans,
    source.id,
    plans
      ? createCheckpoint({
          id: requestId,
          owner: source.id,
          ...(originalRequest ? { originalRequest } : {}),
          ...(originalRequestChars !== undefined ? { originalRequestChars } : {}),
          waves: planned.waves,
          tasks: planned.waves.flat().map((name) => ({ name, wave: linkOf.get(name)!.wave, input: delegateInput(name) })),
          now: (tasks.now ?? Date.now)(),
        })
      : undefined,
  );
  const stamp = () => (tasks.now ?? Date.now)();
  await writer.write((cp) => cp);
  /** Tasks that did not start (refused, or needing one that did not), by name, with why. */
  const notStarted = new Map<string, string>();
  const results: Record<string, unknown>[] = [];
  // The tasks that need nothing first, then each wave after, so the queue holds the rest in order.
  for (const [waveIndex, wave] of planned.waves.entries()) {
    for (const name of wave) {
      const link = linkOf.get(name)!;
      const blocker = link.after.find((dep) => notStarted.has(dep));
      if (blocker) {
        notStarted.set(name, `${blocker} did not start`);
        results.push({ name, wave: link.wave, status: "not started", error: `It needs ${blocker}, which did not start (${notStarted.get(blocker)}).` });
        await writer.write((cp) => noteRefused(cp, name, `It needs ${blocker}, which did not start.`, stamp()));
        continue;
      }
      await writer.write((cp) => noteStarting(cp, name, stamp(), taskRequestId(requestId, name)));
      try {
        const out = (await delegate(
          source,
          taskRequestId(requestId, name),
          {
            ...delegateInput(name),
            ...(originalRequest
              ? { originalRequest, ...(originalRequestChars !== undefined ? { originalRequestChars } : {}) }
              : {}),
          },
          host,
          helpers,
        )) as Record<string, unknown>;
        if (typeof out.taskId === "string" && typeof out.childSessionId === "string") {
          const status = typeof out.status === "string" ? out.status : undefined;
          await writer.write((cp) =>
            noteStarted(cp, name, { taskId: out.taskId as string, childSession: out.childSessionId as string, status }, stamp()),
          );
        } else if (out.status === "waiting" && typeof out.childSessionId === "string") {
          // Queued (or held for review): no row yet, and its job is what a resume looks for.
          const child = out.childSessionId;
          await writer.write((cp) => noteQueued(cp, name, child, stamp()));
        }
        results.push({
          name,
          wave: link.wave,
          ...Object.fromEntries(
            ["taskId", "childSessionId", "status", "title", "waiting", "freshEyes", "modelName", "effort", "alreadyStarted"]
              .filter((key) => out[key] !== undefined)
              .map((key) => [key, out[key]]),
          ),
        });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        notStarted.set(name, why);
        results.push({ name, wave: link.wave, status: "refused", error: why });
        await writer.write((cp) => noteRefused(cp, name, why, stamp()));
      }
    }
    await writer.write((cp) => noteWaveDone(cp, waveIndex + 1, stamp()));
  }
  // Nothing is left to send: the plan is no longer offered for a resume.
  await writer.finish();
  if (notStarted.size === results.length)
    throw new Error(`Nothing started. ${results.map((entry) => `${String(entry.name)}: ${String(entry.error)}`).join(" ")}`);
  // Said in the order the tasks were given, not the order they started.
  const byName = new Map(results.map((entry) => [entry.name, entry]));
  const ordered = parsed.tasks.map((task) => byName.get(task.name)!);
  // WP-144: a task held for its fresh-eyes review waits for the person's word, not for another task.
  const reviewed = ordered.filter((entry) => entry.status === "waiting" && entry.freshEyes === true).length;
  const waiting = ordered.filter((entry) => entry.status === "waiting" && entry.freshEyes !== true).length;
  const problems = ordered.filter((entry) => entry.status === "refused" || entry.status === "not started").length;
  return {
    waves: planned.waves,
    tasks: ordered,
    ...(planned.warnings.length ? { warnings: planned.warnings } : {}),
    ...writer.note(),
    note: forUser`${ordered.length - waiting - reviewed - problems} started now${reviewed ? `; ${reviewed} wait${reviewed === 1 ? "s" : ""} for ${reviewed === 1 ? "its" : "their"} fresh-eyes review` : ""}${waiting ? `; ${waiting} wait${waiting === 1 ? "s" : ""} for what ${waiting === 1 ? "it needs" : "they need"} to be delivered and checked, and start${waiting === 1 ? "s" : ""} by itself then` : ""}${problems ? `; ${problems} did not start (see each task's error)` : ""}. A task whose provider fails is held, not run anyway, and you hear what landed and what did not. Reports come back to you as their own turns. Tell Ash in one line what is running and what waits (in plain words: never a task id, a task name or a folder path), then end your turn.`,
  };
}

/** delegate_task {lead}: a Mono briefs a project's Lead (double delegation); its report comes back later. */
/** What a brief to a Lead names, checked: the Lead, no project, model, effort or isolation, and how to go in when busy. */
function leadRequest(
  input: Record<string, unknown>,
  tasks: AgentAppTasksHost,
): { lead: string; whenBusy: "queue" | "steer" } {
  if (!tasks.briefLead) throw new Error("This build can't brief a Lead");
  const lead = text(input.lead, "lead", 200);
  for (const field of ["project", "model", "effort", "isolation"] as const)
    if (input[field] !== undefined)
      throw new Error(
        `A Lead works in its own chat, project and model: leave out ${field} when you name a lead`,
      );
  const whenBusy = input.whenBusy ?? "queue";
  if (whenBusy !== "queue" && whenBusy !== "steer")
    throw new Error('whenBusy must be "queue" or "steer"');
  return { lead, whenBusy };
}

async function briefLead(
  source: Session,
  mono: { id: string; name?: string },
  tasks: AgentAppTasksHost,
  job: {
    requestId: string;
    brief: string;
    title: string;
    asks: string[];
    goal?: string;
    taskId?: string;
    input: Record<string, unknown>;
    gates?: GateRequest;
    gateFolder?: string;
    standingProject: string;
  },
) {
  const { lead, whenBusy } = leadRequest(job.input, tasks);
  if (!tasks.briefLead) throw new Error("This build can't brief a Lead");
  // WP-156: standing answers ride on the Lead's brief. Off, empty, or unreachable: the brief is unchanged.
  let brief = job.brief;
  if (tasks.standingBrief) {
    try {
      const block = (await tasks.standingBrief(job.standingProject))?.trim() ?? "";
      if (block) brief = `${job.brief}\n\n${block}`;
    } catch {
      brief = job.brief;
    }
  }
  const out = await tasks.briefLead(source, mono, {
    lead,
    // The brief's id in the Lead's chat and the row's request, in the app's namespace (sessions.send's too).
    requestId: `app-${source.id}-${job.requestId}`,
    brief,
    title: job.title,
    ...(job.goal ? { goal: job.goal } : {}),
    ...(job.taskId ? { taskId: job.taskId } : {}),
    askIds: job.asks,
    mode: whenBusy,
  });
  await keepGates(tasks, out.row?.id, job.gates, job.gateFolder);
  // A Lead that stopped on its own question to Ash is waiting on him, not busy with work: say so.
  const asked = out.delivery === "queued" ? tasks.child?.(out.childSessionId)?.pendingQuestion : undefined;
  return {
    taskId: out.row?.id ?? null,
    childSessionId: out.childSessionId,
    status: out.row?.state ?? "running",
    title: job.title,
    lead: out.leadName,
    delivery: out.delivery,
    ...(asked ? { leadState: waitingOnAshLine(asked) } : {}),
    note:
      asked
        ? forUser`${out.leadName} is ${waitingOnAshLine(asked)}. Your brief waits in its chat and goes in as its own turn once Ash answers and ${out.leadName} is free. If you tell anyone where ${out.leadName} is, say it is waiting on Ash for that answer, not busy. Its final report comes back to you as a new turn: say in one line what you handed over and end your turn.`
        : out.delivery === "queued"
        ? `Queued behind ${out.leadName}'s current work; it goes in as its own turn when ${out.leadName} is idle. Its final report comes back to you as a new turn once its workers have reported: say in one line what you handed over and end your turn.`
        : `Briefed ${out.leadName}${out.delivery === "steered" ? " (steered into its running turn)" : ""}. Its final report comes back to you as a new turn once its workers have reported: say in one line what you handed over and end your turn.`,
    ...(out.row ? {} : { note: "It went in, but its task record could not be stored; its report may not come back." }),
  };
}

/** WP-172: the chat's unfinished fan-outs, each with a plain line on what carrying it on would do. */
async function unfinishedPlans(source: Session, tasks: AgentAppTasksHost): Promise<{ plan: string; line: string }[]> {
  const store = tasks.fanoutCheckpoints;
  if (!store) return [];
  const found = await store.list(source.id).catch(() => [] as FanoutCheckpoint[]);
  if (!found.length) return [];
  const waiting = await waitingChildren(source.id, tasks);
  const offered: { plan: string; line: string }[] = [];
  for (const plan of found) {
    // One read per plan. A read that fails leaves the plan out: a running task is never taken for a stopped one.
    const owned = await readPlanRows(source.id, plan, tasks).catch(() => undefined);
    if (!owned) continue;
    const planned = planResume(plan, rowsOfPlan(source.id, plan, owned), (name) => waiting.has(childOf(source.id, plan, name)));
    // Only a plan a resume would act on is offered: what is kept or waiting in the queue needs nothing from anyone.
    if (!planned.start.length && !planned.confirm.length) continue;
    offered.push({
      plan: plan.id,
      line: `${describeResume(planned)} To carry it on, send delegate_tasks with resume "${plan.id}" (and confirm with the names of any stopped task you want started again).`,
    });
  }
  return offered;
}

async function status(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const { tasks } = taskOwner(source, host);
  const ids = taskIds(input.taskIds);
  const rows = ids ? await ownRows(source, tasks, ids) : await tasks.owned(source.id, {});
  // A result returned inside the owner's turn is received: no report turn follows for it.
  const read = rows.filter(
    (row) =>
      !isOpenDelegation(row) &&
      (row.delivery === "pending" ||
        row.delivery === "queued" ||
        row.delivery === "delivered"),
  );
  if (read.length) await tasks.acknowledge(source.id, read);
  const trees = await Promise.all(
    rows.map((row) =>
      tasks.tree ? tasks.tree(row.id).catch(() => [] as Delegation[]) : [],
    ),
  );
  // Waiting for a free worker: no task yet, only the chat it will be (H8).
  const queued = ids ? [] : (tasks.pool?.queued(source.id) ?? []);
  // WP-144: a brief held for a fresh-eyes review is waiting too, though no worker is queued for it.
  const reviewed = ids ? [] : await (tasks.freshEyesWaiting?.(source.id) ?? Promise.resolve([])).catch(() => []);
  const team = ids ? [] : await othersOpen(source, tasks);
  // WP-172: a plan an earlier run did not finish, so First Mate can carry it on (delegate_tasks resume).
  const plans = ids ? [] : await unfinishedPlans(source, tasks);
  return {
    ...(plans.length ? { unfinishedPlans: plans } : {}),
    tasks: rows.map((row, index) =>
      taskView(
        row,
        tasks.child?.(row.childSession),
        trees[index].filter((entry) => entry.parentId === row.id),
      ),
    ),
    ...(queued.length || reviewed.length
      ? {
          waiting: [
            ...queued.map(({ job, line }) => ({
              childSessionId: job.id,
              title: job.title,
              status: "waiting",
              waiting: line,
              ...(job.heavy ? { heavy: true } : {}),
            })),
            ...reviewed.map((entry) => ({
              childSessionId: entry.childSessionId,
              title: entry.title,
              status: "waiting",
              waiting: entry.line,
              freshEyes: true,
            })),
          ],
        }
      : {}),
    ...(team.length ? { othersRunning: team } : {}),
    ...(rows.length || queued.length || reviewed.length
      ? {}
      : {
          note: team.length
            ? "You have no tasks of your own running or owed. othersRunning lists the team's open jobs (read only)."
            : "You have no tasks running or owed, and nobody else on the team has one open.",
        }),
  };
}

/** The team's other open jobs (top-level rows only, not the caller's own), for task_status with no ids. */
async function othersOpen(source: Session, tasks: AgentAppTasksHost) {
  if (!tasks.teamOpen) return [];
  const rows = await tasks.teamOpen().catch(() => [] as Delegation[]);
  return rows
    .filter(
      (row) =>
        row.ownerSession !== source.id &&
        !row.parentId &&
        (row.state === "running" || row.state === "question"),
    )
    .slice(0, 10)
    .map((row) => {
      const child = tasks.child?.(row.childSession);
      return {
        ...statusView(row, child),
        ...(row.ownerMono ? { from: row.ownerMono } : {}),
        ...(row.project ? { project: row.project } : {}),
        startedAt: iso(row.createdAt),
      };
    });
}

async function wait(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const { tasks } = taskOwner(source, host);
  const ids = taskIds(input.taskIds);
  const timeout = input.timeoutSeconds ?? WAIT_MAX_SECONDS;
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 0 ||
    timeout > WAIT_MAX_SECONDS
  )
    throw new Error(`timeoutSeconds must be a whole number from 0 to ${WAIT_MAX_SECONDS}`);
  const now = tasks.now ?? Date.now;
  const deadline = now() + timeout * 1_000;
  // While the chat waits, a worker's question ends the wait (hasPendingQuestion) instead of waking it (H4).
  tasks.waiting?.(source.id, true);
  try {
    let rows = ids ? await ownRows(source, tasks, ids) : await tasks.owned(source.id, {});
    const watched = ids ?? rows.filter(isOpenDelegation).map((row) => row.id);
    // A worker that stalls during the wait ends it too (one already stalled when it began is only reported).
    const stalledBefore = new Set(rows.filter((row) => row.stallKind).map((row) => row.id));
    for (;;) {
      const mine = watched.flatMap((id) => rows.filter((row) => row.id === id));
      const settled = mine.filter((row) => row.state !== "running").map((row) => row.id);
      const running = mine.length - settled.length;
      const stalled = mine.filter((row) => row.state === "running" && row.stallKind).map((row) => row.id);
      const newlyStalled = stalled.some((id) => !stalledBefore.has(id));
      const left = deadline - now();
      if (settled.length || !running || newlyStalled || left <= 0)
        return {
          tasks: mine.map((row) => statusView(row, tasks.child?.(row.childSession))),
          settled,
          running,
          ...(stalled.length ? { stalled } : {}),
          timedOut: !settled.length && !newlyStalled && running > 0,
          ...(mine.some((row) => row.state === "question") ? { hasPendingQuestion: true } : {}),
        };
      await tasks.nextChange(Math.min(left, WAIT_POLL_MS));
      rows = await tasks.owned(source.id, { ids: watched });
    }
  } finally {
    tasks.waiting?.(source.id, false);
  }
}

async function cancel(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const { tasks } = taskOwner(source, host);
  const id = text(input.taskId, "taskId", 600);
  const reason =
    input.reason === undefined ? "Cancelled by its owner." : text(input.reason, "reason", 500);
  // One still waiting for a free worker (named by its childSessionId) never starts.
  if (tasks.pool?.unqueue(source.id, id)) return { taskId: id, status: "cancelled", stopFailed: [] };
  // WP-144: so does one held for a fresh-eyes review.
  if (await tasks.freshEyesCancel?.(source.id, id)) return { taskId: id, status: "cancelled", stopFailed: [] };
  const [row] = await ownRows(source, tasks, [id]);
  const { stopFailed, cancelled } = await tasks.cancel(source.id, row, reason);
  const [after] = await tasks.owned(source.id, { ids: [id] });
  return {
    taskId: id,
    status: (after ?? row).state,
    // What it had delegated in turn was stopped with it.
    ...(cancelled ? { cancelledBeneath: cancelled.filter((entry) => entry !== id).length } : {}),
    stopFailed,
  };
}

/**
 * tasks.cannot (D5): the agent itself says it cannot finish this work, in plain words. A Lead names one of its own tasks;
 * with no taskId it is the running task working in the caller's own chat. The row lands in Ash's Needs you at once
 * (workerStuck.ts), so a Lead that stops without a way forward does not leave its worker looking merely idle, and a done
 * claim over the row is checked against it (leadFlow.ts, followedBriefs.ts).
 */
async function cannot(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const reason = text(input.reason, "reason", 300);
  let tasks: AgentAppTasksHost | undefined = host.tasks;
  let row: Delegation;
  let by: string;
  if (input.taskId === undefined) {
    const mine = await tasks?.selfTask?.(source.id);
    if (!mine)
      throw new Error(
        "No running task works in this chat. Name the taskId of one of yours (task_status lists them).",
      );
    row = mine;
    by = `self:${source.id}`;
  } else {
    // Named tasks are the caller's own, and only a Mono's chat or a coding-team chat owns any.
    tasks = taskOwner(source, host).tasks;
    [row] = await ownRows(source, tasks, [text(input.taskId, "taskId", 600)]);
    by = `owner:${source.id}`;
  }
  if (!tasks?.cannot)
    throw new Error("This build can't record a task as unfinished. Tell Ash in one line what is in the way.");
  if (row.state !== "running")
    throw new Error(`Task ${row.id} is ${row.state}: only running work can be declared unfinished.`);
  const recorded = await tasks.cannot(by, row, reason);
  if (!recorded)
    throw new Error(`Task ${row.id} moved before that was recorded. Read it with task_status.`);
  return {
    taskId: row.id,
    ...(row.title ? { title: row.title } : {}),
    status: row.state,
    needsYou: by.startsWith("owner:"),
    reason,
    note: by.startsWith("owner:")
      ? "It is in Ash's Needs you now. Say in one line what would unblock it, and do not report the work as done."
      : "Your Lead has it now and goes to Ash if only he can unblock it. Say in one line what would unblock it, and do not report the work as done.",
  };
}

function answers(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error('answers must be an object: {"<questionId>":["<optionId>"]}');
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    !entries.length ||
    entries.length > 20 ||
    !entries.every(
      ([key, picked]) =>
        key.length <= 200 &&
        Array.isArray(picked) &&
        picked.length <= 20 &&
        picked.every((option) => typeof option === "string" && option.length <= 2_000),
    )
  )
    throw new Error('answers must map each question id to a list of option ids');
  return value as Record<string, string[]>;
}

async function answer(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const { tasks } = taskOwner(source, host);
  const id = text(input.taskId, "taskId", 128);
  const requestId = input.requestId;
  if (typeof requestId !== "number" || !Number.isInteger(requestId) || requestId < 0)
    throw new Error("requestId must be the question's requestId from task_status");
  if (input.skip !== undefined && input.skip !== true)
    throw new Error("skip must be true");
  if ((input.skip === true) === (input.answers !== undefined))
    throw new Error("Pass answers, or skip:true");
  const reply: UserQuestionReply =
    input.skip === true
      ? { kind: "skipped" }
      : { kind: "answered", answers: answers(input.answers) };
  const [row] = await ownRows(source, tasks, [id]);
  if (row.state !== "question")
    throw new Error(`Task ${id} has no open question.`);
  if (!tasks.answer)
    throw new Error(
      forUser("This build can't answer a worker's question. Ask Ash with your recommendation."),
    );
  await tasks.answer(source.id, row, requestId, reply);
  return { taskId: id, ...(reply.kind === "skipped" ? { skipped: true } : { answered: true }) };
}

/** Who may set what workers run on: a Mono's own chat, never a worker, a habit run or the checker. */
function modelCaller(source: Session, host: AgentAppHost) {
  const mono =
    host.isMono(source.id) && !host.isHabitRun?.(source.id) ? host.monoOf?.(source.id) : undefined;
  if (!mono || mono.id === CHECKER_MONO_ID)
    throw new Error("Only a Mono sets what its workers run on, from its own chat.");
  return mono;
}

/**
 * WP-176: a first mate's own chat may set a spend limit, and the gate decides what it may do: a first limit or a lower
 * one only. Raising or clearing needs the person's tap in Settings. The whole-app limit is Settings only. A habit run,
 * a worker and the checker may not write at all.
 */
function spendCaller(source: Session, host: AgentAppHost) {
  const mono =
    host.isMono(source.id) && !host.isHabitRun?.(source.id) ? host.monoOf?.(source.id) : undefined;
  if (!mono || mono.id === CHECKER_MONO_ID)
    throw new Error("Only a first mate sets a spend limit, from its own chat.");
  return mono;
}

function worksOn(projects: readonly string[], folder: string, projectId: string): boolean {
  return projects.some(
    (entry) =>
      entry === projectId ||
      entry === folder ||
      pathKey(entry) === pathKey(folder) ||
      pathKey(entry) === pathKey(projectId),
  );
}

/** The Mono's own default, written only if the roster is still the one just read. */
function saveMonoDefault(
  id: string,
  pick: { cli?: string; model?: string; effort?: string } | undefined,
): void {
  const commit = commitRoster((roster) => {
    const index = roster.findIndex((mono) => mono.id === id);
    if (index < 0) return null;
    const next = { ...roster[index] };
    if (pick) next.workerDefault = pick;
    else delete next.workerDefault;
    const copy = roster.slice();
    copy[index] = next;
    return copy;
  });
  if (commit === "missing") throw new Error("That Mono isn't on this Mac.");
  if (commit === "lost") throw new Error("That change didn't stick. Try again.");
}

/**
 * tasks.workers: how many workers the chat's project runs at once, and how many of them on heavy tests. Without numbers
 * it reads them; with them (what Ash said: "let hivra run 20 workers today") it saves them, as the project's settings do.
 * WP-89: scope, cli, model, effort and clear set what those workers run on.
 */
async function workers(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const settingSpend =
    input.amountUsd !== undefined ||
    input.period !== undefined ||
    input.warnAt !== undefined ||
    input.spendClear !== undefined;
  const choosingModel =
    input.cli !== undefined ||
    input.model !== undefined ||
    input.effort !== undefined ||
    input.clear !== undefined;
  // A scope on its own still means "set the model". A spend limit uses scope too, and must not ask for a model.
  const choosing = choosingModel || (input.scope !== undefined && !settingSpend);
  // WP-176: reading a limit needs no special caller. Setting one does, before the project is resolved.
  const spendMono = settingSpend ? spendCaller(source, host) : undefined;
  const setter = choosing ? modelCaller(source, host) : undefined;
  const { owner, tasks } = taskOwner(source, host);
  if (!tasks.pool) throw new Error("This build starts every worker at once; it has no per-project limit.");
  const named = input.project === undefined ? undefined : text(input.project, "project", 4096);
  const folder = owner.team?.folder ?? (named !== undefined ? (tasks.hubProjectFolder?.(named) ?? named) : source.cwd);
  const policyFolder = crewScopeFolder(owner, source, named, tasks);
  const project = owner.team?.project ?? (named !== undefined && tasks.hubProjectFolder?.(named) ? named : (tasks.hubProjectId?.(folder) ?? folder));
  const count = (value: unknown, field: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 30)
      throw new Error(`${field} must be a whole number from 1 to 30`);
    return value;
  };
  const monoId = setter?.id ?? owner.mono?.id;
  const storedMono = monoId ? findMono(monoId) : undefined;
  const currentMono = storedMono?.workerDefault ?? owner.mono?.workerDefault;
  const currentProject = tasks.pool.projectDefault?.(project);
  const currentSystem = tasks.pool.systemDefault?.();
  const current =
    input.scope === "project" ? currentProject : input.scope === "system" ? currentSystem : currentMono;
  const planned = choosing ? planWorkerChoice(input, current, launchCatalog()) : undefined;
  if (planned?.scope === "project" && setter && !worksOn(setter.projects, folder, project))
    throw new Error("This Mono doesn't work on that project.");
  // WP-141 HIGH 2: under Always use my default, no default (the Mono's, the project's or everyone's) is changed from a chat.
  // The lock is read for the Mono, the folder and every saved scope: a change anywhere it reaches is refused.
  // Round 6: a host with no lock hook counts as locked, never as unlocked.
  const anyLock = planned && (tasks.crewAnyLock ? (await tasks.crewAnyLock()) === true : true);
  if (planned && ((await tasks.crewPolicy?.(owner.mono?.id, policyFolder))?.lock || anyLock))
    throw new Error(
      planned.scope === "system"
        ? "Always use my default is on, so the default for every worker can't be changed from here."
        : "Always use my default is on, so a Mono's or project's default can't be changed from here.",
    );
  const next = { workers: count(input.workers, "workers"), heavy: count(input.heavy, "heavy") };
  const limits =
    next.workers === undefined && next.heavy === undefined
      ? tasks.pool.limits(project)
      : tasks.pool.setLimits(project, {
          ...(next.workers !== undefined ? { workers: next.workers } : {}),
          ...(next.heavy !== undefined ? { heavy: next.heavy } : {}),
        });
  if (planned && setter) {
    if (planned.scope === "mono") saveMonoDefault(setter.id, planned.pick);
    else if (planned.scope === "project") {
      setProjectWorkerModel(
        project,
        planned.pick?.model
          ? {
              model: planned.pick.model,
              ...(planned.pick.cli ? { cli: planned.pick.cli } : {}),
              ...(planned.pick.effort ? { effort: planned.pick.effort } : {}),
            }
          : undefined,
      );
    } else setSystemWorkerDefault(planned.pick);
  }
  const monoPick = (monoId ? findMono(monoId)?.workerDefault : undefined) ?? (planned?.scope === "mono" ? undefined : currentMono);
  const projectPick = tasks.pool.projectDefault?.(project);
  const systemPick = tasks.pool.systemDefault?.();
  const monoRules = carriedMonoRules(storedMono?.crewRules ?? owner.mono?.crewRules);
  const loaded = await lineRulesFor(folder, monoRules);
  const rules = loaded ?? monoRules;
  const catalog = launchCatalog();
  const changed = [planned && !planned.pick ? scopeClearLine(planned.scope) : "", planned?.dropped ?? ""]
    .filter(Boolean)
    .join(" ");
  // WP-141 L9: the sentence names the lock and Never use, so the person sees what a chat can and cannot change.
  const policy = await tasks.crewPolicy?.(owner.mono?.id, policyFolder);
  const force = describeInForce({
    defaults: routeDefaults({ mono: monoPick, project: projectPick, system: systemPick }),
    catalog,
    rules,
    ...(policy ? { policy } : {}),
  });
  const rulesLine = crewRuleSentence(rules, catalog);
  let spendNote = "";
  if (settingSpend && spendMono) {
    if (input.scope === undefined)
      throw new Error("Say whether this is just this Mono, this project, or everything.");
    if (input.scope !== "mono" && input.scope !== "project" && input.scope !== "system")
      throw new Error('scope must be "mono", "project" or "system".');
    if (input.scope === "mono")
      throw new Error("A spend limit covers this project or everything, not one Mono.");
    const period = input.period === "day" || input.period === "month" ? input.period : null;
    if (!period) throw new Error('period must be "day" or "month".');
    if (input.spendClear !== undefined && input.spendClear !== true) throw new Error("spendClear must be true");
    if (input.scope === "system")
      throw new Error("The whole-app spend limit is set in Settings.");
    const scope = "project";
    if (!worksOn(spendMono.projects, folder, project))
      throw new Error("This Mono doesn't work on that project.");
    const who = project;
    const label = project;
    const here = spendSnapshot().book;
    if (input.spendClear === true) {
      // The gate matches a limit by its project's id or folder, so the clear asks it directly (a name match here missed
      // a limit saved under its id). What it reports decides the line: cleared, nothing there, or refused.
      const dropped = clearSpendLimit(scope, who, period, here.revision, { by: "first-mate" });
      if (dropped.written) spendNote = `Spend limit cleared for ${label}.`;
      else if (dropped.reason === NO_SPEND_LIMIT_TO_CLEAR) spendNote = `There is no spend limit to clear for ${label}.`;
      else throw new Error(dropped.reason ?? "That change didn't stick. Try again.");
    } else {
      const warnAt = input.warnAt === undefined ? 0.8 : input.warnAt;
      if (typeof input.amountUsd !== "number" || !Number.isFinite(input.amountUsd) || input.amountUsd <= 0)
        throw new Error("amountUsd must be a positive number.");
      if (typeof warnAt !== "number" || !Number.isFinite(warnAt) || warnAt < 0.5 || warnAt > 1)
        throw new Error("warnAt must be from 0.5 to 1.");
      const clean = sanitizeSpendLimit({
        scope,
        project: who,
        period,
        amountUsd: input.amountUsd,
        warnAt,
      });
      if (!clean) throw new Error("amountUsd must be a positive number.");
      const saved = saveSpendLimit(clean, spendSnapshot().book.revision, { by: "first-mate" });
      if (!saved.written) throw new Error(saved.reason ?? "That change didn't stick. Try again.");
      const when = clean.period === "day" ? "today" : "this month";
      spendNote = `Spend limit for ${label} is ${formatMeasuredUsd(clean.amountUsd)} ${when}.`;
    }
  }
  const spendRows = spendFor(project);
  const spend: SpendLimit[] | null = spendRows.length ? spendRows : null;
  const line = [limitsLine(projectName(folder), limits), spendNote, changed, force.sentence, rulesLine].filter(Boolean).join(" ");
  if (planned && setter) {
    const previous = current?.cli || current?.model || current?.effort ? current : undefined;
    host.postCard?.(source.id, {
      type: "worker-default",
      scope: planned.scope,
      mono: setter.id,
      ...(planned.scope === "system" ? {} : { project }),
      line,
      ...(previous ? { previous } : {}),
    });
    host.noteActivity?.({
      kind: "worker.default",
      summary: activityNoteSummary(line),
      project: planned.scope === "system" ? "app" : project,
      target: planned.scope,
      actorId: setter.id,
      actorName: setter.name ?? setter.id,
    });
  }
  return {
    project,
    workers: limits.workers,
    heavy: limits.heavy,
    line,
    inForce: {
      cli: force.route.cli,
      model: force.route.model,
      effort: force.route.effort,
      cliFrom: force.route.cliFrom,
      modelFrom: force.route.modelFrom,
      effortFrom: force.route.effortFrom,
      skipped: force.route.skipped,
    },
    scopes: {
      mono: monoPick ?? null,
      project: projectPick ?? null,
      system: systemPick ?? null,
    },
    spend,
  };
}

/** SC-4: what a started task keeps of its brief. */
export type KeptBrief = { stamp?: string; checks: readonly CheckLine[]; leave: readonly string[] };

/** How many times a brief's lines are asked to be kept before the first mate is told they weren't. */
const KEEP_TRIES = 3;

/** What the first mate reads when a task's check lines or do-not-touch list could not be saved. */
const BRIEF_NOT_KEPT =
  "Its check lines or do-not-touch list could not be saved on the task, so the app will not run or enforce them. Send the same call again, with the same clientRequestId, to save them.";

/**
 * SC-4: keep a task's brief lines, stamp and list, trying a few times. Nothing to keep keeps nothing. A miss is not a
 * failed start, but a task whose lines were not saved would pass with none run: false says so, and the first mate is told.
 */
async function keepBrief(tasks: AgentAppTasksHost, id: string | null | undefined, brief: KeptBrief): Promise<boolean> {
  if (!id || !tasks.keepBrief) return true;
  if (!brief.stamp && !brief.checks.length && !brief.leave.length) return true;
  for (let attempt = 0; attempt < KEEP_TRIES; attempt += 1) {
    try {
      await tasks.keepBrief(id, brief);
      return true;
    } catch {
      // Try again: the store may only have been busy.
    }
  }
  // A stamp alone is not enforced by anything the first mate relies on; lines and a list are.
  return !(brief.checks.length || brief.leave.length);
}

/**
 * SC-4: the project folder a brief's work belongs to, as `delegate` resolves it before anything starts: the project the
 * call names (a coding-team chat's own when it names none), else the chat's own folder.
 */
function briefFolderOf(source: Session, owner: ReturnType<typeof taskOwner>["owner"], named: string | undefined, tasks: AgentAppTasksHost) {
  return named !== undefined && !owner.team ? (tasks.hubProjectFolder?.(named) ?? named) : source.cwd;
}

/**
 * SC-4: whether this project's testing mode refuses a code brief with no check line. Asked only then: a brief that carries
 * a line, or isn't code, never reads the mode. A mode the app can't read never refuses (it would be stricter than told).
 */
async function fullModeRefusal(
  tasks: AgentAppTasksHost,
  folder: string,
  codeBrief: boolean,
  lines: readonly CheckLine[],
): Promise<string | undefined> {
  if (!codeBrief || lines.length > 0 || !tasks.testingMode) return undefined;
  const project = tasks.hubProjectId?.(folder) ?? folder;
  const mode = await tasks.testingMode(project).catch(() => undefined);
  return checksRefusal(mode, codeBrief, lines);
}

/** Keep a task's gates. A miss is not a failed start: the same call again saves them. */
async function keepGates(
  tasks: AgentAppTasksHost,
  id: string | null | undefined,
  request: GateRequest | undefined,
  folder?: string,
) {
  if (!id || !request || !tasks.saveGates) return;
  await tasks.saveGates(id, request, folder).catch(() => undefined);
}

/**
 * task_accept: the first mate's call on a finished task whose checks are unsure. Accepting and refusing both need a
 * reason (SC-3a: an accept without a pass is logged and shown on the task's row), in the same words Rust uses. Another
 * chat's task is refused before the command runs.
 */
async function accept(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const { tasks } = taskOwner(source, host);
  const id = text(input.taskId, "taskId", 600);
  if (typeof input.accept !== "boolean") throw new Error("accept must be true or false");
  const raw = input.reason;
  const reason = typeof raw === "string" ? raw.trim() : undefined;
  if (raw !== undefined && (typeof raw !== "string" || !reason || reason.length > 500))
    throw new Error("reason must be a non-empty string under 500 characters");
  if (!reason)
    throw new Error(
      input.accept
        ? "Say why you accept it without a pass (reason), in one plain line."
        : "Say why it isn't done (reason), in one plain line.",
    );
  const [row] = await ownRows(source, tasks, [id]);
  if (!tasks.decideGates) throw new Error("This build can't accept a task's checks.");
  await tasks.decideGates(source.id, row.id, input.accept, reason);
  return {
    taskId: row.id,
    accepted: input.accept,
    gateVerdict: input.accept ? "passed" : "failed",
  };
}

/** Hivra WP-14: task_message and ask_person, on the caller's own tasks. */
async function firstMateTool(
  source: Session,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
) {
  const { owner, tasks } = taskOwner(source, host);
  if (!tasks.firstMate) throw new Error("This build can't steer workers or ask the person yet.");
  if (action === "tasks.message") {
    const [row] = await ownRows(source, tasks, [text(input.taskId, "taskId", 128)]);
    // The first mate's crew rules ride with every message, so a rule added since the brief reaches the running worker.
    // A message too long to carry them still goes; the worker keeps the copy in its brief.
    const crew = owner.mono ? await readCrewRules(owner.mono.id, owner.name) : undefined;
    const said = typeof input.text === "string" ? input.text.trim() : "";
    const withCrew = crew && said && said.length + crew.length + 2 <= STEER_TEXT_MAX ? { ...input, text: `${said}\n\n${crew}` } : input;
    return taskMessage(source, requestId, withCrew, row, tasks.firstMate);
  }
  // WP-172: the question that starts a stopped task again is the app's alone: an agent may not create it (not even
  // without an answer), since the card would carry the words the agent chose.
  if (action === "tasks.ask" && isAgainKey(input.key))
    throw new Error("Only the app asks whether a stopped task starts again. Name the task in a resume instead; the person answers it in Needs.");
  const ids = taskIds(input.taskIds) ?? [];
  const rows = ids.length ? await ownRows(source, tasks, ids) : [];
  // The project's home is the coding team's, else the chat's folder. A task's own project is not a way to pick another.
  const project = owner.team?.project || tasks.hubProjectId?.(source.cwd) || source.cwd;
  if (rows.some((row) => row.project && row.project !== project)) {
    throw new Error("That task is in another project. Ask from the chat that owns it.");
  }
  return askPerson(source, input, { mono: owner.mono?.id, project }, rows, tasks.firstMate);
}

/**
 * WP-141: tasks.pick. The crew's pick for a job, a signed-in CLI or a Mono this chat may brief, with a short reason.
 * The first mate's model or Lead is an override: Always use my default drops it, and the reason says so. Nothing starts.
 */
async function pickWorker(source: Session, input: Record<string, unknown>, host: AgentAppHost): Promise<unknown> {
  const { owner, tasks } = taskOwner(source, host);
  if (!tasks.crewPick) throw new Error("This build can't pick a worker");
  const role = input.role === undefined ? undefined : text(input.role, "role", 40).toLowerCase();
  const title = input.title === undefined ? "" : text(input.title, "title", 200);
  const brief = input.brief === undefined ? "" : text(input.brief, "brief", BRIEF_MAX);
  const labels = [...new Set([...(role ? [role] : []), ...crewLabels(areasNamed(title, brief))])];
  const paths = crewPaths(fileList(input.files), filesNamed(brief));
  const onBridge = source.harness === "claude" && claudeRunsOnSubscriptionBridge();
  const override = callerOverride(taskModel(input.model, source, onBridge), input.effort);
  const roster = owner.mono && tasks.pickMonos ? tasks.pickMonos(owner.mono.id) : [];
  let monoOverride: string | undefined;
  if (input.lead !== undefined) {
    const named = text(input.lead, "lead", 200);
    const want = named.toLowerCase();
    const hit = roster.find((mono) => [mono.id, mono.name, mono.lead].some((name) => name?.toLowerCase() === want));
    if (!hit) throw new Error(`No Lead "${named}" among the ones you can brief.`);
    monoOverride = hit.id;
  }
  // How deep this chat sits: the depth a task from it would have, less one. A pick starts nothing, so the open-task cap is not asked.
  let depth = 0;
  try {
    depth = Math.max(0, ((await tasks.checkDepth?.(source.id, { fanout: false })) ?? 1) - 1);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  // WP-141 LOW 7: the pick reads the same folder's policy the launch that follows reads.
  const folder = crewScopeFolder(owner, source, undefined, tasks);
  const projectKey = tasks.hubProjectId?.(folder) ?? folder;
  // A CLI with no room left at its provider is not free for this job; the project's own cap is the same for every CLI.
  const atCap = CLI_ORDER.filter((cli) => {
    const admission = tasks.pool?.admit({ id: `pick-${source.id}-${cli}`, project: projectKey, projectName: projectName(folder), heavy: false, harness: cli });
    return admission?.start === false && admission.reason === "limit";
  });
  const monoRules = carriedMonoRules(owner.mono?.crewRules);
  const defaults = routeDefaults({
    mono: owner.mono?.workerDefault,
    project: await projectDefaultFor(tasks, folder),
    system: tasks.pool?.systemDefault?.(),
  });
  const catalog = launchCatalog();
  const pick = await tasks.crewPick({
    labels,
    paths,
    ...(override ? { override } : {}),
    ...(folder ? { project: folder } : {}),
    ...(owner.mono?.id ? { mono: owner.mono.id, leadMonoId: owner.mono.id } : {}),
    ...(monoRules.length ? { monoRules } : {}),
    ...(defaults ? { defaults } : {}),
    ...(Object.keys(catalog).length ? { catalog } : {}),
    monos: roster.map(({ id, name, role: monoRole }) => ({ id, ...(name ? { name } : {}), ...(monoRole ? { role: monoRole } : {}) })),
    depth,
    atCap,
    ...(monoOverride ? { monoOverride } : {}),
  });
  const reason = routeReasonLine(pick?.reason);
  if (!pick?.ok) return { ok: false, reason: reason || "Nothing available can take it." };
  const mono = pick.monoId ? roster.find((row) => row.id === pick.monoId) : undefined;
  if (mono) {
    return {
      ok: true,
      monoId: mono.id,
      leadName: mono.name ?? mono.id,
      reason,
      delegateWith: { lead: mono.lead },
      note: "Brief that Lead with delegate_task and lead as delegateWith says. Tell Ash in one line who it goes to and why.",
    };
  }
  const cli = pick.cli && isCli(pick.cli) ? pick.cli : undefined;
  if (!cli) return { ok: false, reason: reason || "Nothing available can take it." };
  const model = pick.model ?? ((HARNESSES as readonly string[]).includes(cli) ? preferredModelId(cli as HarnessId) : undefined);
  return {
    ok: true,
    cli,
    cliName: cliLabel(cli),
    ...(pick.model ? { model: pick.model } : {}),
    ...(pick.effort ? { effort: pick.effort } : {}),
    reason,
    delegateWith: { ...(model ? { model } : {}), ...(pick.effort ? { effort: pick.effort } : {}) },
    note: "Start it with delegate_task, passing delegateWith. Tell Ash in one line which CLI it runs on and why.",
  };
}

function routeReasonLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 240) : "";
}

/** The `tasks.*` actions (agentApp.ts dispatches them here after checking their fields). */
export function handleTasks(
  source: Session,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  helpers: TaskHelpers,
): Promise<unknown> {
  switch (action) {
    case "tasks.delegate":
      return delegate(source, requestId, input, host, helpers);
    case "tasks.fanout":
      return fanout(source, requestId, input, host, helpers);
    case "tasks.status":
      return status(source, input, host);
    case "tasks.wait":
      return wait(source, input, host);
    case "tasks.cancel":
      return cancel(source, input, host);
    case "tasks.cannot":
      return cannot(source, input, host);
    case "tasks.answer":
      return answer(source, input, host);
    case "tasks.accept":
      return accept(source, input, host);
    case "tasks.workers":
      return Promise.resolve().then(() => workers(source, input, host));
    case "tasks.pick":
      return pickWorker(source, input, host);
    case "tasks.message":
    case "tasks.ask":
      return firstMateTool(source, requestId, action, input, host);
  }
  return Promise.reject(new Error(`Unknown app action: ${action}`));
}
