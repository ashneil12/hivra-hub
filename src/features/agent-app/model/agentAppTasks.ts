// The delegate tool's app side (docs/PHASE-2-DESIGN.md, H3): the `tasks.*` app actions, over the delegation rows that
// H2 stores (src-tauri/src/delegations.rs, monos/model/delegations.ts). The `monocode` MCP server (src-tauri/src/
// mcp_server.rs) maps delegate_task / task_status / task_wait / task_cancel / task_cannot / task_answer onto these; `monocode app
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
import { MONO_HOME_FENCE } from "../../hub/model/hubMcp";
import type { QuickLaunch } from "../../quick-composer/model/quickComposer";
import { modelsFor } from "../../sessions/model/models";
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
import { waitingOnAshLine } from "../../hub/model/chatQuestions";
import { workerMemoryBlock } from "../../hub/model/hubMemoryPrimer";
import type { AgentAppHost } from "./agentApp";
import {
  limitsLine,
  type Admission,
  type AdmitInput,
  type QueuedWorker,
  type WorkerLimits,
} from "../../monos/model/workerPool";
import { projectName } from "../../../shared/lib/paths";
import { forUser } from "../../hub/model/userName";

/**
 * How many workers a project runs at once (board H8, monos/model/workerPool.ts). The app builds it on the delegation
 * rows, E5's accounts and the saved queue; absent, every worker starts at once, as before.
 */
export type WorkerPoolHost = {
  /** Every row still running or asking, from every chat (a project's count and the ports in use). */
  openRows(): Delegation[];
  /** Start this worker now, or let it wait and say why. One the app is starting from the queue always starts. */
  admit(job: AdmitInput): Admission;
  /** It waits: kept in order with what starts it later (and its card shows in the chat that asked). */
  enqueue(job: QueuedWorker, launch: QuickLaunch): void;
  /** It started: out of the queue, and counted as heavy if it is. */
  started(job: { id: string; heavy: boolean }): void;
  /** The chat's waiting workers, with why each waits now. */
  queued(owner: string): { job: QueuedWorker; line: string }[];
  /** The chat took back one of its waiting workers (task_cancel). */
  unqueue(owner: string, id: string): boolean;
  limits(project: string): WorkerLimits;
  setLimits(project: string, next: Partial<WorkerLimits>): WorkerLimits;
};

/** The FIELDS entries of the task actions (agentApp.ts). */
export const TASK_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "tasks.delegate",
    ["brief", "title", "asks", "goal", "project", "model", "effort", "isolation", "heavy", "lead", "whenBusy", "redoes"],
  ],
  ["tasks.workers", ["project", "workers", "heavy"]],
  ["tasks.status", ["taskIds"]],
  ["tasks.wait", ["taskIds", "timeoutSeconds"]],
  ["tasks.cancel", ["taskId", "reason"]],
  ["tasks.cannot", ["taskId", "reason"]],
  ["tasks.answer", ["taskId", "requestId", "answers", "skip"]],
];

/** What a delegation's row records beyond a plain monitored launch. */
export type DelegationMeta = {
  title: string;
  askIds: string[];
  goal?: string;
  /** The hub project id (what Ash OS resolves), when the folder is one of the hub's projects. */
  project?: string;
};

/** A worker chat as this window has it. */
export type TaskChild = Pick<Session, "busy" | "pendingQuestion"> & {
  /** When it last did something (now, while it works); the row's own time otherwise. */
  lastActiveAt?: number;
};

/** The app's side of the task tools (App.tsx builds it on the delegation tracker). */
export type AgentAppTasksHost = {
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
  /** The running task working in this chat itself, newest first: what `tasks.cannot` with no taskId declares on. */
  selfTask?(sessionId: string): Promise<Delegation | undefined>;
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
  const found = /\bPORT=(\d{4,5})\b/.exec(brief ?? "");
  return found ? Number(found[1]) : undefined;
}

/**
 * What every worker works by, in its brief (baseline, 20 Oct: two workers shared a port and one killed the other's dev
 * server): its own port, never another's process, its own checkout.
 */
export function workerRules(port: number): string {
  return `<worker_rules>\n- Other workers may be running in this project at the same time. Your port is ${port}: start any server you need (a dev server, an API, a preview) on it, with PORT=${port} or the tool's own port option, never on the project's default port.\n- Never stop, kill or restart a process you didn't start (no pkill, killall or kill of anyone else's server). If a port or a file is busy, use your own port, wait, or say so in your report.\n- Work in your own checkout, the folder you were started in.\n- ${MONO_HOME_FENCE}\n</worker_rules>`;
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

/** A model id from any harness, or a family ("sonnet") among the caller's own harness's models. */
function taskModel(
  value: unknown,
  source: Session,
): { harness: HarnessId; model: string } | undefined {
  if (value === undefined) return undefined;
  const wanted = text(value, "model", 128);
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

/** Who delegates: a Mono's own chat (signed with its name), or a coding-team chat (signed "<Project> coding team"). */
type TaskOwner = { name: string; mono?: { id: string; name?: string }; team?: { project: string; folder: string } };

/** Only a Mono's own chat or a coding-team chat has tasks; the checker only reads. */
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

/** A task as task_wait reports it: status only. */
function statusView(row: Delegation, child: TaskChild | undefined) {
  return {
    taskId: row.id,
    ...(row.title ? { title: row.title } : {}),
    status: row.state,
    activity: activity(row, child),
    lastActiveAt: lastActiveAt(row, child),
    hasPendingQuestion: row.state === "question",
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
  return {
    ...statusView(row, child),
    childSessionId: row.childSession,
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

async function delegate(
  source: Session,
  requestId: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  helpers: TaskHelpers,
) {
  const { owner, tasks } = taskOwner(source, host);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    throw new Error(
      "request ID must use letters, digits, underscores or hyphens (up to 100)",
    );
  const brief = text(input.brief, "brief", BRIEF_MAX);
  const title =
    input.title === undefined ? firstLine(brief) : text(input.title, "title", 200);
  const asks = askIds(input.asks);
  const goal = input.goal === undefined ? undefined : text(input.goal, "goal", 1_000);
  // A stuck task of the caller's this one takes on (a retry, or one piece of a split): checked before anything starts.
  const redoes =
    input.redoes === undefined ? undefined : (await ownRows(source, tasks, [text(input.redoes, "redoes", 128)]))[0];
  if (input.lead !== undefined) {
    if (redoes) throw new Error("redoes is for your own workers' tasks; leave it out when you brief a Lead.");
    if (!owner.mono)
      throw new Error(
        "A coding-team chat hands its work to its own workers; only a Mono briefs a project's Lead. Leave out lead.",
      );
    return briefLead(source, owner.mono, tasks, { requestId, brief, title, asks, goal, input });
  }
  if (input.whenBusy !== undefined)
    throw new Error("whenBusy is for a brief to a Lead (lead); a worker starts in a chat of its own");
  const asked = input.isolation;
  if (asked !== undefined && asked !== "shared" && asked !== "worktree")
    throw new Error('isolation must be "shared" or "worktree"');
  if (input.heavy !== undefined && typeof input.heavy !== "boolean")
    throw new Error("heavy must be true or false");
  // The Lead's own call: this job runs heavy tests, so its project runs only so many like it at once.
  const heavy = input.heavy === true;
  const named =
    input.project === undefined ? undefined : text(input.project, "project", 4096);
  // A coding-team chat works on its own project only: naming it is fine, naming another is not.
  if (owner.team && named !== undefined && named !== owner.team.project && (tasks.hubProjectFolder?.(named) ?? named) !== owner.team.folder)
    throw new Error(`A coding-team chat delegates on its own project (${owner.team.project}). Leave out project.`);
  // Every Mono but a Lead works through teams (hub/model/monoTeams.ts): a project's work goes to its coding team as a
  // brief to its Lead, and its own work to a worker in its own team's folder, made the first time.
  let ownTeam: { folder: string; name: string } | undefined;
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
      ownTeam = await tasks.monoWork.ownTeam(owner.mono);
    }
  }
  const model = taskModel(input.model, source);
  // The worker works on this chat's project (hub/model/hubMcp.ts), so its brief carries that project's memory.
  const memory = await (tasks.memoryBrief ?? workerMemoryBlock)(source.id, model?.harness ?? source.harness).catch(
    () => undefined,
  );
  const id = `app-${source.id}-${requestId}`;
  // Idempotent (H8c): a task already recorded for this request is never started a second time, so a waiting worker
  // asked again after a window died mid-start (its claim ran out) or a retried call only reads it back.
  const [already] = await tasks.owned(source.id, { requestIds: [id] }).catch(() => [] as Delegation[]);
  if (already && already.state !== "cancelled") {
    tasks.pool?.started({ id, heavy });
    return {
      taskId: already.id,
      childSessionId: id,
      status: already.state,
      title: already.title ?? title,
      alreadyStarted: true,
      note: "This task had already started; it was not started again. Its report comes back to you as its own turn.",
    };
  }
  // The workers this chat still has out: each holds a port, and one working in the same project shares its repo.
  const out = (await tasks.owned(source.id, {}).catch(() => [] as Delegation[])).filter(isOpenDelegation);
  // Every chat's workers, where the app knows them: a Lead's and its coding-team chats' share one repo and the ports.
  const everyone = [...out, ...(tasks.pool?.openRows() ?? []).filter((row) => row.childSession !== id)];
  const port = workerPort(
    id,
    new Set(everyone.flatMap((row) => (row.brief ? [portOfBrief(row.brief)].filter((p): p is number => !!p) : []))),
  );
  const launchWith = (workspaceMode: "worktree" | "current") =>
    helpers.startLaunch(
      source,
      {
        prompt: briefPrompt(owner.name, brief, goal, memory, workerRules(port)),
        ...(ownTeam
          ? { project: ownTeam.folder }
          : named !== undefined && !owner.team
            ? { project: tasks.hubProjectFolder?.(named) ?? named }
            : {}),
        ...(model ? { harness: model.harness, model: model.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        // Workers run with full access so a permission prompt never strands them with nobody watching; Ash's own
        // hooks (his red-line guards) still run, and their questions go to this Mono (docs/PHASE-2-DESIGN.md H4).
        runtimeMode: WORKER_RUNTIME_MODE,
        workspaceMode,
      },
      host,
    );
  let launch = launchWith(asked === "worktree" ? "worktree" : "current");
  // Several workers in one repo at once each get a checkout of their own unless the chat said "shared": the baseline
  // (20 Oct) had two in one checkout stopping each other's dev server.
  const projectOf = (folder: string) => tasks.hubProjectId?.(folder) ?? folder;
  // Never in a Mono's own team: its folder is no repository (the checkout would never be made, and the worker never run).
  const auto =
    !ownTeam && asked === undefined && everyone.some((row) => (row.project ?? "") === projectOf(launch.cwd));
  if (auto) launch = launchWith("worktree");
  const hubProject = tasks.hubProjectId?.(launch.cwd);
  // Over the project's limit, or the provider has no account with room: it waits and starts by itself (H8).
  if (tasks.pool) {
    const job = {
      id,
      project: projectOf(launch.cwd),
      projectName: ownTeam?.name ?? projectName(launch.cwd),
      heavy,
      harness: launch.harness,
    };
    const admission = tasks.pool.admit(job);
    if (!admission.start) {
      tasks.pool.enqueue(
        {
          ...job,
          ownerSession: source.id,
          requestId,
          title,
          queuedAt: (tasks.now ?? Date.now)(),
          input,
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
        ...(heavy ? { heavy: true } : {}),
        note: forUser`${admission.line} It starts by itself, in the order you asked, and reports back to you like any other task once it has run; there is nothing for you to do about it (task_cancel with its childSessionId as taskId takes it back). Tell Ash in one line what is running and what waits (in plain words: never a task id or a folder path), then end your turn.`,
      };
    }
  }
  const meta = {
    title,
    askIds: asks,
    ...(goal ? { goal } : {}),
    ...(hubProject ? { project: hubProject } : {}),
  };
  // Always monitored: a task reports back to the chat that delegated it.
  try {
    await host.start(launch, id, undefined, source.id, meta);
  } catch (error) {
    // A checkout of its own couldn't be made (a folder that isn't a git repository): the shared one, as asked for.
    if (!auto) throw error;
    launch = launchWith("current");
    await host.start(launch, id, undefined, source.id, meta);
  }
  tasks.pool?.started({ id, heavy });
  helpers.fileStarted(source, launch, id, host);
  const [row] = await tasks.owned(source.id, { requestIds: [id] });
  // What the Lead did about its stuck task shows on that task's card (and survives a restart: it's in its row's log).
  if (redoes && row) await tasks.redo?.(source.id, redoes, row.id).catch(() => undefined);
  return {
    taskId: row?.id ?? null,
    childSessionId: id,
    status: row?.state ?? "running",
    title,
    cwd: launch.cwd,
    harness: launch.harness,
    model: launch.model,
    ...(launch.workspaceMode === "worktree" ? { isolation: "worktree" } : {}),
    ...(auto && launch.workspaceMode === "worktree"
      ? { isolationWhy: "Another worker is working in this project, so this one has a checkout of its own." }
      : {}),
    ...(heavy ? { heavy: true } : {}),
    // Its port, which its brief tells it to use for any server it starts.
    port,
    // Work of a Mono's own runs in its team: the worker's chat shows there, under the Mono's.
    ...(ownTeam ? { team: ownTeam.name } : {}),
    note: row
      ? forUser`Running${ownTeam ? ` in ${ownTeam.name}, where its chat shows under yours` : ""}. Its report comes back to you as its own turn soon after it finishes. Start any other independent work now, tell Ash in one line what is running (in plain words: never its task id or a folder path) and end your turn; whenever he writes meanwhile, answer him at once.`
      : "It started, but its task record could not be stored; its report still comes back to you.",
  };
}

/** delegate_task {lead}: a Mono briefs a project's Lead (double delegation); its report comes back later. */
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
    input: Record<string, unknown>;
  },
) {
  const { input } = job;
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
  const out = await tasks.briefLead(source, mono, {
    lead,
    // The brief's id in the Lead's chat and the row's request, in the app's namespace (sessions.send's too).
    requestId: `app-${source.id}-${job.requestId}`,
    brief: job.brief,
    title: job.title,
    ...(job.goal ? { goal: job.goal } : {}),
    askIds: job.asks,
    mode: whenBusy,
  });
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
  const team = ids ? [] : await othersOpen(source, tasks);
  return {
    tasks: rows.map((row, index) =>
      taskView(
        row,
        tasks.child?.(row.childSession),
        trees[index].filter((entry) => entry.parentId === row.id),
      ),
    ),
    ...(queued.length
      ? {
          waiting: queued.map(({ job, line }) => ({
            childSessionId: job.id,
            title: job.title,
            status: "waiting",
            waiting: line,
            ...(job.heavy ? { heavy: true } : {}),
          })),
        }
      : {}),
    ...(team.length ? { othersRunning: team } : {}),
    ...(rows.length || queued.length
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
    needsYou: true,
    reason,
    note: "It is in Ash's Needs you now. Say in one line what would unblock it, and do not report the work as done.",
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

/**
 * tasks.workers: how many workers the chat's project runs at once, and how many of them on heavy tests. Without numbers
 * it reads them; with them (what Ash said: "let hivra run 20 workers today") it saves them, as the project's settings do.
 */
function workers(source: Session, input: Record<string, unknown>, host: AgentAppHost) {
  const { owner, tasks } = taskOwner(source, host);
  if (!tasks.pool) throw new Error("This build starts every worker at once; it has no per-project limit.");
  const named = input.project === undefined ? undefined : text(input.project, "project", 4096);
  const folder = owner.team?.folder ?? (named !== undefined ? (tasks.hubProjectFolder?.(named) ?? named) : source.cwd);
  const project = owner.team?.project ?? (named !== undefined && tasks.hubProjectFolder?.(named) ? named : (tasks.hubProjectId?.(folder) ?? folder));
  const count = (value: unknown, field: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 30)
      throw new Error(`${field} must be a whole number from 1 to 30`);
    return value;
  };
  const next = { workers: count(input.workers, "workers"), heavy: count(input.heavy, "heavy") };
  const limits =
    next.workers === undefined && next.heavy === undefined
      ? tasks.pool.limits(project)
      : tasks.pool.setLimits(project, {
          ...(next.workers !== undefined ? { workers: next.workers } : {}),
          ...(next.heavy !== undefined ? { heavy: next.heavy } : {}),
        });
  return { project, ...limits, line: limitsLine(projectName(folder), limits) };
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
    case "tasks.workers":
      return Promise.resolve().then(() => workers(source, input, host));
  }
  return Promise.reject(new Error(`Unknown app action: ${action}`));
}
