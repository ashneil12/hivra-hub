// The delegate tool's app side (docs/PHASE-2-DESIGN.md, H3): the `tasks.*` app actions, over the delegation rows that
// H2 stores (src-tauri/src/delegations.rs, monos/model/delegations.ts). The `monocode` MCP server (src-tauri/src/
// mcp_server.rs) maps delegate_task / task_status / task_wait / task_cancel / task_answer onto these; `monocode app
// tasks.*` reaches them too.
//
// - Only a Mono's own chat has tasks: not a habit run, a worker, a plain chat or the checker (it only reads).
// - A chat sees and moves only its own rows. control.rs ties the app token to the chat it was made for and the store
//   answers by owner, so a model that knows another chat's task id still gets "no task of yours".
// - Calls work only inside the caller's active turn (control.rs), and each one answers within control.rs's 35 s:
//   tasks.wait blocks for at most 25 s, and the MCP server strings waits together.
// - tasks.delegate is sessions.start with a brief: the same child id (`app-<caller>-<request>`, so the worker's chat
//   shows nested under the Mono), the same monitored launch, and a row recorded with the job's title, Ash's ask ids,
//   the goal and the hub project id.
// - A finished result read through tasks.status counts as received: the row is acknowledged and its report turn
//   dropped.
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
import type { AgentAppHost } from "./agentApp";

/** The FIELDS entries of the task actions (agentApp.ts). */
export const TASK_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "tasks.delegate",
    ["brief", "title", "asks", "goal", "project", "model", "effort", "isolation", "lead", "whenBusy"],
  ],
  ["tasks.status", ["taskIds"]],
  ["tasks.wait", ["taskIds", "timeoutSeconds"]],
  ["tasks.cancel", ["taskId", "reason"]],
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
  /** The owner read these finished results in its turn: they are acknowledged and their report turns dropped. */
  acknowledge(owner: string, rows: Delegation[]): Promise<void>;
  /** Resolves on the next change to any row, or after `ms`. */
  nextChange(ms: number): Promise<void>;
  /** Stop a task and everything beneath it (H4's stopTree), cancelling what is still owed. */
  cancel(
    owner: string,
    row: Delegation,
    reason: string,
  ): Promise<{ stopFailed: string[]; stopped?: string[]; cancelled?: string[] }>;
  /** The chat started (true) or finished (false) a tasks.wait call: its workers' questions come back through the wait. */
  waiting?(owner: string, on: boolean): void;
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
  /**
   * Leadership team: brief a project's Lead in its own long-running chat instead of starting a worker (double
   * delegation, hub/model/leadershipDelegation.ts). `lead` is what the Mono named; the host finds it among the Leads
   * this Mono may brief, records the row (owner: this chat, child: the Lead's chat) and sends the brief in.
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

/** Every brief opens with this, so nothing mistakes it for Ash's own words (the studio's sweep skips such chats). */
export function briefPrompt(owner: string, brief: string, goal?: string): string {
  return [
    `[MonoCode brief from ${owner}]`,
    brief,
    ...(goal ? [`Done when: ${goal}`] : []),
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
      `asks must be up to ${ASKS_MAX} Ash OS ask ids (a_...), as ash_record returned them`,
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

/** Only a Mono's own chat has tasks; the checker only reads. */
function taskOwner(source: Session, host: AgentAppHost) {
  const mono = host.isMono(source.id) ? host.monoOf?.(source.id) : undefined;
  if (!mono)
    throw new Error(
      host.isHabitRun?.(source.id)
        ? "A habit run can't delegate. Post what you found; the Mono delegates from its own chat."
        : "Only a Mono's own chat can delegate and manage tasks. A worker reports to the chat that delegated it.",
    );
  if (mono.id === CHECKER_MONO_ID)
    throw new Error("The checker only reads. It never delegates or starts work.");
  if (!host.tasks) throw new Error("Tasks are unavailable in this build");
  return { mono, tasks: host.tasks };
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
  const { mono, tasks } = taskOwner(source, host);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    throw new Error(
      "request ID must use letters, digits, underscores or hyphens (up to 100)",
    );
  const brief = text(input.brief, "brief", BRIEF_MAX);
  const title =
    input.title === undefined ? firstLine(brief) : text(input.title, "title", 200);
  const asks = askIds(input.asks);
  const goal = input.goal === undefined ? undefined : text(input.goal, "goal", 1_000);
  if (input.lead !== undefined)
    return briefLead(source, mono, tasks, { requestId, brief, title, asks, goal, input });
  if (input.whenBusy !== undefined)
    throw new Error("whenBusy is for a brief to a Lead (lead); a worker starts in a chat of its own");
  const isolation = input.isolation ?? "shared";
  if (isolation !== "shared" && isolation !== "worktree")
    throw new Error('isolation must be "shared" or "worktree"');
  const named =
    input.project === undefined ? undefined : text(input.project, "project", 4096);
  const model = taskModel(input.model, source);
  const launch = helpers.startLaunch(
    source,
    {
      prompt: briefPrompt(mono.name || mono.id, brief, goal),
      ...(named !== undefined
        ? { project: tasks.hubProjectFolder?.(named) ?? named }
        : {}),
      ...(model ? { harness: model.harness, model: model.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      // Workers run with full access so a permission prompt never strands them with nobody watching; Ash's own
      // hooks (his red-line guards) still run, and their questions go to this Mono (docs/PHASE-2-DESIGN.md H4).
      runtimeMode: WORKER_RUNTIME_MODE,
      workspaceMode: isolation === "worktree" ? "worktree" : "current",
    },
    host,
  );
  const id = `app-${source.id}-${requestId}`;
  const hubProject = tasks.hubProjectId?.(launch.cwd);
  // Always monitored: a task reports back to the Mono that delegated it.
  await host.start(launch, id, undefined, source.id, {
    title,
    askIds: asks,
    ...(goal ? { goal } : {}),
    ...(hubProject ? { project: hubProject } : {}),
  });
  helpers.fileStarted(source, launch, id, host);
  const [row] = await tasks.owned(source.id, { requestIds: [id] });
  return {
    taskId: row?.id ?? null,
    childSessionId: id,
    status: row?.state ?? "running",
    title,
    cwd: launch.cwd,
    harness: launch.harness,
    model: launch.model,
    ...(launch.workspaceMode === "worktree" ? { isolation: "worktree" } : {}),
    note: row
      ? "Running. Its report comes back to you as its own turn soon after it finishes. Start any other independent work now, tell Ash in one line what is running and end your turn; whenever he writes meanwhile, answer him at once."
      : "It started, but its task record could not be stored; its report still comes back to you.",
  };
}

/** delegate_task {lead}: the leadership team briefs a project's Lead (double delegation); its report comes back later. */
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
  return {
    taskId: out.row?.id ?? null,
    childSessionId: out.childSessionId,
    status: out.row?.state ?? "running",
    title: job.title,
    lead: out.leadName,
    delivery: out.delivery,
    note:
      out.delivery === "queued"
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
  return {
    tasks: rows.map((row, index) =>
      taskView(
        row,
        tasks.child?.(row.childSession),
        trees[index].filter((entry) => entry.parentId === row.id),
      ),
    ),
    ...(rows.length ? {} : { note: "You have no tasks running or owed." }),
  };
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
    for (;;) {
      const mine = watched.flatMap((id) => rows.filter((row) => row.id === id));
      const settled = mine.filter((row) => row.state !== "running").map((row) => row.id);
      const running = mine.length - settled.length;
      const left = deadline - now();
      if (settled.length || !running || left <= 0)
        return {
          tasks: mine.map((row) => statusView(row, tasks.child?.(row.childSession))),
          settled,
          running,
          timedOut: !settled.length && running > 0,
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
  const id = text(input.taskId, "taskId", 128);
  const reason =
    input.reason === undefined ? "Cancelled by its owner." : text(input.reason, "reason", 500);
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
      "This build can't answer a worker's question. Ask Ash with your recommendation.",
    );
  await tasks.answer(source.id, row, requestId, reply);
  return { taskId: id, ...(reply.kind === "skipped" ? { skipped: true } : { answered: true }) };
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
    case "tasks.answer":
      return answer(source, input, host);
  }
  return Promise.reject(new Error(`Unknown app action: ${action}`));
}
